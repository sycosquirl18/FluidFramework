import {
    Browser,
    IClient,
    IConnectionDetails,
    IContentMessage,
    IDeltaHandlerStrategy,
    IDeltaManager,
    IDeltaQueue,
    IDocumentDeltaStorageService,
    IDocumentMessage,
    IDocumentService,
    IDocumentSystemMessage,
    ISequencedDocumentMessage,
    ISignalMessage,
    ITelemetryLogger,
    ITrace,
    MessageType,
} from "@prague/container-definitions";
import { Deferred, isSystemType, PerformanceEvent } from "@prague/utils";
import * as assert from "assert";
import { EventEmitter } from "events";
import { ContentCache } from "./contentCache";
import { debug } from "./debug";
import { DeltaConnection } from "./deltaConnection";
import { DeltaQueue } from "./deltaQueue";

const MaxReconnectDelay = 8000;
const InitialReconnectDelay = 1000;
const MissingFetchDelay = 100;
const MaxFetchDelay = 10000;
const MaxBatchDeltas = 2000;
const DefaultChunkSize = 16 * 1024;

// This can be anything other than null
const ImmediateNoOpResponse = "";

// TODO - These two should come from connect protocol. For now, splitting will never occur since
// it's bigger than DefaultChunkSize
const DefaultMaxContentSize = 32 * 1024;
const DefaultContentBufferSize = 10;

/**
 * Manages the flow of both inbound and outbound messages. This class ensures that shared objects receive delta
 * messages in order regardless of possible network conditions or timings causing out of order delivery.
 */
export class DeltaManager extends EventEmitter implements IDeltaManager<ISequencedDocumentMessage, IDocumentMessage> {
    public readonly clientType: string;

    private pending: ISequencedDocumentMessage[] = [];
    private fetching = false;

    // Flag indicating whether or not we need to update the reference sequence number
    private updateHasBeenRequested = false;
    private updateSequenceNumberTimer: any;

    // Flag indicating whether the client is only a receiving client. Client starts in readonly mode.
    // Switches only on self client join message or on message submission.
    private readonly = true;

    // The minimum sequence number and last sequence number received from the server
    private minSequenceNumber: number = 0;

    // There are three numbers we track
    // * lastQueuedSequenceNumber is the last queued sequence number
    // * largestSequenceNumber is the largest seen sequence number
    private lastQueuedSequenceNumber: number | undefined;
    private largestSequenceNumber: number | undefined;
    private baseSequenceNumber: number = 0;

    // tslint:disable:variable-name
    private readonly _inbound: DeltaQueue<ISequencedDocumentMessage>;
    private readonly _inboundSignal: DeltaQueue<ISignalMessage>;
    private readonly _outbound: DeltaQueue<IDocumentMessage>;
    // tslint:enable:variable-name

    private connecting: Deferred<IConnectionDetails> | undefined | null;
    private connection: DeltaConnection | undefined;
    private clientSequenceNumber = 0;
    private closed = false;

    private handler: IDeltaHandlerStrategy | undefined;
    private deltaStorageP: Promise<IDocumentDeltaStorageService> | undefined;

    private readonly contentCache = new ContentCache(DefaultContentBufferSize);

    public get inbound(): IDeltaQueue<ISequencedDocumentMessage | undefined> {
        return this._inbound;
    }

    public get outbound(): IDeltaQueue<IDocumentMessage | undefined> {
        return this._outbound;
    }

    public get inboundSignal(): IDeltaQueue<ISignalMessage | undefined> {
        return this._inboundSignal;
    }

    public get referenceSequenceNumber(): number {
        return this.baseSequenceNumber;
    }

    public get minimumSequenceNumber(): number {
        return this.minSequenceNumber;
    }

    public get maxMessageSize(): number {
        assert(this.connection);
        return this.connection!.details.maxMessageSize || DefaultChunkSize;
    }

    // TODO - This should be instantiated as a part of connection protocol.
    public get maxContentSize(): number {
        return DefaultMaxContentSize;
    }

    constructor(
        private readonly service: IDocumentService,
        private readonly client: IClient | null,
        private readonly logger: ITelemetryLogger) {
        super();

        /* tslint:disable:strict-boolean-expressions */
        this.clientType = (!this.client || !this.client.type) ? Browser : this.client.type;
        // Inbound message queue
        this._inbound = new DeltaQueue<ISequencedDocumentMessage>((op, callback) => {
            if (op!.contents === undefined) {
                this.handleOpContent(op!, callback);
            } else {
                this.processInboundOp(op!, callback);
            }
        });

        this._inbound.on("error", (error) => {
            this.emit("error", error);
        });

        // Outbound message queue
        this._outbound = new DeltaQueue<IDocumentMessage>(
            (message, callback: (error?) => void) => {
                if (this.shouldSplit(message!.contents as string)) {
                    debug(`Splitting content from envelope.`);
                    this.connection!.submitAsync(message!).then(
                        () => {
                            this.contentCache.set({
                                clientId: this.connection!.details.clientId,
                                clientSequenceNumber: message!.clientSequenceNumber,
                                contents: message!.contents as string,
                            });
                            message!.contents = undefined;
                            this.connection!.submit(message);
                            callback();
                        },
                        (error) => {
                            callback(error);
                        });
                } else {
                    this.connection!.submit(message);
                    callback();
                }
            });

        this._outbound.on("error", (error) => {
            this.emit("error", error);
        });

        // Inbound signal queue
        this._inboundSignal = new DeltaQueue<ISignalMessage>((message, callback: (error?) => void) => {
            // tslint:disable no-unsafe-any
            message!.content = JSON.parse(message!.content);
            this.handler!.processSignal(message!);
            callback();
        });

        this._inboundSignal.on("error", (error) => {
            this.emit("error", error);
        });

        // Require the user to start the processing
        this._inbound.pause();
        this._outbound.pause();
        this._inboundSignal.pause();
    }

    /**
     * Sets the sequence number from which inbound messages should be returned
     */
    public attachOpHandler(sequenceNumber: number, handler: IDeltaHandlerStrategy, resume: boolean) {
        debug("Attached op handler", sequenceNumber);

        // The MSN starts at the base the manager is initialized to
        this.baseSequenceNumber = sequenceNumber;
        this.minSequenceNumber = sequenceNumber;
        this.lastQueuedSequenceNumber = sequenceNumber;
        this.largestSequenceNumber = sequenceNumber;
        this.handler = handler;

        // We are ready to process inbound messages
        if (resume) {
            this._inbound.systemResume();
            this._inboundSignal.systemResume();
            this.fetchMissingDeltas("DocumentOpen", sequenceNumber);
        }
    }

    public async connect(reason: string): Promise<IConnectionDetails> {
        if (this.connecting) {
            return this.connecting.promise;
        }

        // Connect to the delta storage endpoint
        const storageDeferred = new Deferred<IDocumentDeltaStorageService>();
        this.deltaStorageP = storageDeferred.promise;
        this.service.connectToDeltaStorage().then(
            (deltaStorage) => {
                storageDeferred.resolve(deltaStorage);
            },
            (error) => {
                // Could not get delta storage promise. For now we assume this is not possible and so simply
                // emit the error.
                this.emit("error", error);
            });

        this.connecting = new Deferred<IConnectionDetails>();
        this.connectCore(reason, InitialReconnectDelay);

        return this.connecting.promise;
    }

    public submit(type: MessageType, contents: string | null): number {
        // Start adding trace for the op.
        const traces: ITrace[] = [
            {
                action: "start",
                service: this.clientType,
                timestamp: Date.now(),
            }];

        const coreMessage: IDocumentMessage = {
            clientSequenceNumber: ++this.clientSequenceNumber,
            contents,
            referenceSequenceNumber: this.baseSequenceNumber,
            traces,
            type,
        };

        const message = this.createOutboundMessage(type, coreMessage);
        this.readonly = false;

        this.stopSequenceNumberUpdate();
        this._outbound.push(message);

        return message.clientSequenceNumber;
    }

    public submitSignal(content: any) {
        this.connection!.submitSignal(content);
    }

    public async getDeltas(reason: string, fromInitial: number, to?: number): Promise<ISequencedDocumentMessage[]> {
        if (this.closed) {
            // Might need to change to non-error event
            this.logger.sendErrorEvent({eventName: "GetDeltasClosedConnection" });
            return [];
        }

        let retry: number = 0;
        let from: number = fromInitial;
        const allDeltas: ISequencedDocumentMessage[] = [];

        const telemetryEvent = PerformanceEvent.Start(this.logger, {
            eventName: "GetDeltas",
            from,
            reason,
            to,
        });

        // tslint:disable-next-line:no-constant-condition
        while (true) {
            const maxFetchTo = from + MaxBatchDeltas;
            const fetchTo = to === undefined ? maxFetchTo : Math.min(maxFetchTo, to);

            // Let exceptions here propagate through, without hitting retry logic below
            const deltaStorage = await this.deltaStorageP!;

            let deltasRetrievedLast = 0;
            let success = true;

            try {
                // Grab a chunk of deltas - limit the number fetched to MaxBatchDeltas
                const deltas = await deltaStorage.get(from, fetchTo);

                // Note that server (or driver code) can push here something unexpected, like undefined
                // Exception thrown as result of it will result in us retrying
                allDeltas.push(...deltas);

                deltasRetrievedLast = deltas.length;
                const lastFetch = deltasRetrievedLast > 0 ? deltas[deltasRetrievedLast - 1].sequenceNumber : from;

                // If we have no upper bound and fetched less than the max deltas - meaning we got as many as exit -
                // then we can resolve the promise. We also resolve if we fetched up to the expected to. Otherwise
                // we will look to try again
                if ((to === undefined && maxFetchTo !== lastFetch + 1) || to === lastFetch + 1) {
                    telemetryEvent.end({lastFetch, totalDeltas: allDeltas.length, retries: retry});
                    return allDeltas;
                }

                // Attempt to fetch more deltas. If we didn't receive any in the previous call we up our retry
                // count since something prevented us from seeing those deltas
                from = lastFetch;
            } catch (error) {
                // There was an error fetching the deltas. Up the retry counter
                this.logger.logException({eventName: "GetDeltasError", fetchTo, from, retry: retry + 1}, error);
                success = false;
            }

            retry = deltasRetrievedLast === 0 ? retry + 1 : 0;
            const delay = Math.min(
                MaxFetchDelay,
                retry !== 0 ? MissingFetchDelay * Math.pow(2, retry) : 0);

            telemetryEvent.reportProgress({
                delay,
                deltasRetrievedLast,
                deltasRetrievedTotal: allDeltas.length,
                replayFrom: from,
                retry,
                success,
            });

            await new Promise((resolve) => {
                setTimeout(() => { resolve(); }, delay);
            });
        }
    }

    public enableReadonlyMode(): void {
        this.stopSequenceNumberUpdate();
        this.readonly = true;
    }

    public disableReadonlyMode(): void {
        this.readonly = false;
    }

    /**
     * Closes the connection and clears inbound & outbound queues.
     */
    public close(): void {
        this.closed = true;
        this.stopSequenceNumberUpdate();
        if (this.connection) {
            this.connection.close();
        }
        this._inbound.clear();
        this._outbound.clear();
        this._inboundSignal.clear();
        this.removeAllListeners();
    }

    private shouldSplit(contents: string): boolean {
        return (!!contents) && (contents.length > this.maxContentSize);
    }

    // Specific system level message attributes are need to be looked at by the server.
    // Hence they are separated and promoted as top level attributes.
    private createOutboundMessage(
        type: MessageType,
        coreMessage: IDocumentMessage): IDocumentMessage {
        if (isSystemType(type)) {
            const data = coreMessage.contents as string;
            coreMessage.contents = null;
            const outboundMessage: IDocumentSystemMessage = {
                ...coreMessage,
                data,
            };
            return outboundMessage;
        } else {
            return coreMessage;
        }
    }

    private connectCore(reason: string, delay: number): void {
        // Reconnection is only enabled for browser clients.
        const reconnect = this.clientType === Browser;

        DeltaConnection.Connect(
            this.service,
            this.client!).then(
            (connection) => {
                this.connection = connection;

                this._outbound.systemResume();

                this.clientSequenceNumber = 0;

                // If first connection resolve the promise with the details
                if (this.connecting) {
                    this.connecting.resolve(connection.details);
                    this.connecting = null;
                }

                connection.on("op", (documentId: string, messages: ISequencedDocumentMessage[]) => {
                    if (this.handler) {
                        if (messages instanceof Array) {
                            this.enqueueMessages(messages);
                        } else {
                            this.enqueueMessages([messages]);
                        }
                    }
                });

                connection.on("op-content", (message: IContentMessage) => {
                    if (this.handler) {
                        this.contentCache.set(message);
                    }
                });

                connection.on("signal", (message: ISignalMessage) => {
                    if (this.handler) {
                        this._inboundSignal.push(message);
                    }
                });

                connection.on("nack", (target: number) => {
                    this._outbound.systemPause();
                    this._outbound.clear();

                    this.emit("disconnect", true);
                    if (!reconnect) {
                        this._inbound.systemPause();
                        this._inbound.clear();
                        this._inboundSignal.systemPause();
                        this._inboundSignal.clear();
                    } else {
                        this.connectCore("Reconnecting on nack", InitialReconnectDelay);
                    }
                });

                connection.on("disconnect", (disconnectReason) => {
                    this._outbound.systemPause();
                    this._outbound.clear();

                    this.emit("disconnect", false);
                    if (!reconnect) {
                        this._inbound.systemPause();
                        this._inbound.clear();
                        this._inboundSignal.systemPause();
                        this._inboundSignal.clear();
                    } else {
                        this.connectCore("Reconnecting on disconnect", InitialReconnectDelay);
                    }
                });

                connection.on("pong", (latency) => {
                    this.emit("pong", latency);
                });

                connection.on("error", (error) => {
                    this.emit("error", error);
                });

                this.processInitialMessages(
                    connection.details.initialMessages,
                    connection.details.initialContents,
                    connection.details.initialSignals);

                // Notify of the connection
                this.emit("connect", connection.details);
            },
            (error) => {
                // tslint:disable-next-line:no-parameter-reassignment
                delay = Math.min(delay, MaxReconnectDelay);
                // tslint:disable-next-line:no-parameter-reassignment
                reason = `Connection failed - trying again in ${delay}ms`;
                debug(reason, error);
                this.logger.logException({eventName: "DeltaConnectionFailure", delay}, error);
                setTimeout(() => this.connectCore(reason, delay * 2), delay);
            });
    }

    private processInitialMessages(
            messages: ISequencedDocumentMessage[] | undefined,
            contents: IContentMessage[] | undefined,
            signals: ISignalMessage[] | undefined): void {
        // confirm the status of the handler and inbound queue
        if (!this.handler || this._inbound.paused) {
            // process them once the queue is ready
            this._inbound.once("resume", () => {
                this.enqueInitalOps(messages, contents);
            });
        } else {
            this.enqueInitalOps(messages, contents);
        }
        if (!this.handler || this._inboundSignal.paused) {
            // process them once the queue is ready
            this._inboundSignal.once("resume", () => {
                this.enqueInitalSignals(signals);
            });
        } else {
            this.enqueInitalSignals(signals);
        }
    }

    private enqueInitalOps(
            messages: ISequencedDocumentMessage[] | undefined,
            contents: IContentMessage[] | undefined): void {
        if (contents && contents.length > 0) {
            for (const content of contents) {
                this.contentCache.set(content);
            }
        }
        if (messages && messages.length > 0) {
            this.catchUp("enqueInitalOps", messages);
        }
    }

    private enqueInitalSignals(signals: ISignalMessage[] | undefined): void {
        if (signals && signals.length > 0) {
            for (const signal of signals) {
                this._inboundSignal.push(signal);
            }
        }
    }

    private handleOpContent(op: ISequencedDocumentMessage, callback: (error?) => void): void {
        const opContent = this.contentCache.peek(op.clientId);
        if (!opContent) {
            this.waitForContent(op.clientId, op.clientSequenceNumber, op.sequenceNumber).then((content) => {
                this.mergeAndProcess(op, content, callback);
            }, (err) => {
                callback(err);
            });
        } else if (opContent.clientSequenceNumber > op.clientSequenceNumber) {
            this.fetchContent(op.clientId, op.clientSequenceNumber, op.sequenceNumber).then((content) => {
                this.mergeAndProcess(op, content, callback);
            }, (err) => {
                callback(err);
            });
        } else if (opContent.clientSequenceNumber < op.clientSequenceNumber) {
            let nextContent = this.contentCache.get(op.clientId);
            while (nextContent && nextContent.clientSequenceNumber < op.clientSequenceNumber) {
                nextContent = this.contentCache.get(op.clientId);
            }
            assert(nextContent, "No content found");
            assert.equal(op.clientSequenceNumber, nextContent!.clientSequenceNumber, "Invalid op content order");
            this.mergeAndProcess(op, nextContent!, callback);
        } else {
            this.mergeAndProcess(op, this.contentCache.get(op.clientId)!, callback);
        }
    }

    private processInboundOp(op: ISequencedDocumentMessage, callback: (error?) => void): void {
        this.processMessage(op).then(
            () => {
                callback();
            },
            (error) => {
                /* tslint:disable:no-unsafe-any */
                callback(error);
            });
    }

    private mergeAndProcess(message: ISequencedDocumentMessage, contentOp: IContentMessage, callback): void {
        message.contents = contentOp.contents;
        this.processInboundOp(message, callback);
    }

    private enqueueMessages(messages: ISequencedDocumentMessage[]): void {
        for (const message of messages) {
            if (this.largestSequenceNumber !== undefined) {
                this.largestSequenceNumber = Math.max(this.largestSequenceNumber, message.sequenceNumber);
            }
            // Check that the messages are arriving in the expected order
            if (this.lastQueuedSequenceNumber !== undefined  &&
                message.sequenceNumber !== this.lastQueuedSequenceNumber + 1) {
                this.handleOutOfOrderMessage(message);
            } else {
                this.lastQueuedSequenceNumber = message.sequenceNumber;
                this._inbound.push(message);
            }
        }
    }

    private processMessage(message: ISequencedDocumentMessage): Promise<void> {
        if (this.baseSequenceNumber !== undefined) {
            assert.equal(message.sequenceNumber, this.baseSequenceNumber + 1);
        }
        const startTime = Date.now();

        // TODO Remove after SPO picks up the latest build.
        if (message.contents && typeof message.contents === "string" && message.type !== MessageType.ClientLeave) {
            message.contents = JSON.parse(message.contents);
        }

        // TODO handle error cases, NACK, etc...
        const contextP = this.handler!.prepare(message);
        return contextP.then((context) => {
            // Add final ack trace.
            if (message.traces && message.traces.length > 0) {
                message.traces.push({
                    action: "end",
                    service: this.clientType,
                    timestamp: Date.now(),
                });
            }

            // Watch the minimum sequence number and be ready to update as needed
            this.minSequenceNumber = message.minimumSequenceNumber;
            this.baseSequenceNumber = message.sequenceNumber;

            this.handler!.process(message, context);

            // We will queue a message to update our reference sequence number upon receiving a server operation. This
            // allows the server to know our true reference sequence number and be able to correctly update the minimum
            // sequence number (MSN). We don't acknowledge other message types similarly (like a min sequence number
            // update) to avoid acknowledgement cycles (i.e. ack the MSN update, which updates the MSN, then ack the
            // update, etc...).
            if (message.type === MessageType.Operation ||
                message.type === MessageType.Propose) {
                this.updateSequenceNumber(message.type);
            }

            const endTime = Date.now();
            this.emit("processTime", endTime - startTime);

            // Call the post-process function
            return this.handler!.postProcess(message, context);
        });
    }

    /**
     * Handles an out of order message retrieved from the server
     */
    private handleOutOfOrderMessage(message: ISequencedDocumentMessage) {
        if (this.lastQueuedSequenceNumber !== undefined && message.sequenceNumber <= this.lastQueuedSequenceNumber) {
            this.logger.sendTelemetryEvent({
                eventName: "DuplicateMessage",
                lastQueued: this.lastQueuedSequenceNumber!,
                sequenceNumber: message.sequenceNumber,
            });
            return;
        }

        this.pending.push(message);
        if (this.lastQueuedSequenceNumber === undefined) {
            return;
        }
        this.fetchMissingDeltas("HandleOutOfOrderMessage", this.lastQueuedSequenceNumber, message.sequenceNumber);
    }

    /**
     * Retrieves the missing deltas between the given sequence numbers
     */
    private fetchMissingDeltas(reason: string, from: number, to?: number) {
        // Exit out early if we're already fetching deltas
        if (this.fetching) {
            this.logger.sendTelemetryEvent({eventName: "fetchMissingDeltasAlreadyFetching", from: from!, reason});
            return;
        }

        this.fetching = true;

        this.getDeltas(reason, from, to).then(
            (messages) => {
                this.fetching = false;
                this.catchUp(reason, messages);
            });
    }

    private async waitForContent(
            clientId: string,
            clientSeqNumber: number,
            seqNumber: number): Promise<IContentMessage> {
        const lateContentHandler = (clId: string) => {
            if (clientId === clId) {
                const lateContent = this.contentCache.peek(clId);
                if (lateContent && lateContent.clientSequenceNumber === clientSeqNumber) {
                    this.contentCache.removeListener("content", lateContentHandler);
                    debug(`Late content fetched from buffer ${clientId}: ${clientSeqNumber}`);
                    return this.contentCache.get(clientId);
                }
            }
        };

        this.contentCache.on("content", lateContentHandler);
        const content = await this.fetchContent(clientId, clientSeqNumber, seqNumber);
        this.contentCache.removeListener("content", lateContentHandler);

        return content;
    }

    private async fetchContent(
            clientId: string,
            clientSeqNumber: number,
            seqNumber: number): Promise<IContentMessage> {
        const messages = await this.getDeltas("fetchContent", seqNumber, seqNumber);
        assert.ok(messages.length > 0, "Content not found in DB");

        const message = messages[0];
        assert.equal(message.clientId, clientId, "Invalid fetched content");
        assert.equal(message.clientSequenceNumber, clientSeqNumber, "Invalid fetched content");

        debug(`Late content fetched from DB ${clientId}: ${clientSeqNumber}`);
        return {
            clientId: message.clientId,
            clientSequenceNumber: message.clientSequenceNumber,
            contents: message.contents,
        };
    }

    private catchUp(reason: string, messages: ISequencedDocumentMessage[]): void {
        this.logger.sendPerformanceEvent({
            eventName: "CatchUp",
            messageCount: messages.length,
            pendingCount: this.pending.length,
            reason,
        });

        // Apply current operations
        this.enqueueMessages(messages);

        // Then sort pending operations and attempt to apply them again.
        // This could be optimized to stop handling messages once we realize we need to fetch missing values.
        // But for simplicity, and because catching up should be rare, we just process all of them.
        const pendingSorted = this.pending.sort((a, b) => a.sequenceNumber - b.sequenceNumber);
        this.pending = [];
        this.enqueueMessages(pendingSorted);
    }

    /**
     * Acks the server to update the reference sequence number
     */
    private updateSequenceNumber(type: MessageType): void {
        // Exit early for readonly clients. They don't take part in the minimum sequence number calculation.
        if (this.readonly) {
            return;
        }

        // On a quorum proposal, immediately send a response to expedite the approval.
        if (type === MessageType.Propose) {
            this.submit(MessageType.NoOp, ImmediateNoOpResponse);
            return;
        }

        // If an update has already been requeested then mark this fact. We will wait until no updates have
        // been requested before sending the updated sequence number.
        if (this.updateSequenceNumberTimer) {
            this.updateHasBeenRequested = true;
            return;
        }

        // Clear an update in 100 ms
        this.updateSequenceNumberTimer = setTimeout(() => {
            this.updateSequenceNumberTimer = undefined;

            // If a second update wasn't requested then send an update message. Otherwise defer this until we
            // stop processing new messages.
            if (!this.updateHasBeenRequested) {
                this.submit(MessageType.NoOp, null);
            } else {
                this.updateHasBeenRequested = false;
                this.updateSequenceNumber(type);
            }
        }, 100);
    }

    private stopSequenceNumberUpdate(): void {
        if (this.updateSequenceNumberTimer) {
            clearTimeout(this.updateSequenceNumberTimer);
        }

        this.updateHasBeenRequested = false;
        this.updateSequenceNumberTimer = undefined;
    }
}
