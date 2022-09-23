import PQueue from 'p-queue';
import { Serialize } from 'eosjs';
import { Abi } from 'eosjs/dist/eosjs-rpc-interfaces';
import { StaticPool } from 'node-worker-threads-pool';

import logger from './utils/winston';
import {
    BlockRequestType,
    IBlockReaderOptions, ShipBlockResponse
} from './types/ship';
import { deserializeEosioType, serializeEosioType  } from './utils/eosio';
import { getTypesFromAbi } from './utils/serialize';

import * as AbiEOS from "@eosrio/node-abieos";

import {
    EosioAction
} from './types/eosio';const WebSocket = require('ws');

const createHash = require("sha1-uint8array").createHash


function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

const DS_TYPES = [
    'transaction',
    'code_id',
    'account_v0',
    'account_metadata_v0',
    'code_v0',
    'contract_table_v0',
    'contract_row_v0',
    'contract_index64_v0',
    'contract_index128_v0',
    'contract_index256_v0',
    'contract_index_double_v0',
    'contract_index_long_double_v0',
    'account',
    'account_metadata',
    'code',
    'contract_table',
    'contract_row',
    'contract_index64',
    'contract_index128',
    'contract_index256',
    'contract_index_double',
    'contract_index_long_double'
];
const debug = true;
export function hashTxAction(action: EosioAction) {
    if (debug) {
        // debug mode, pretty responses
        let uid = action.account;
        uid = uid + "." + action.name;
        for (const auth of action.authorization) {
            uid = uid + "." + auth.actor;
            uid = uid + "." + auth.permission;
        }
        uid = uid + "." + createHash().update(action.data).digest("hex");
        return uid;
    } else {
        // release mode, only hash
        const hash = createHash();
        hash.update(action.account);
        hash.update(action.name);
        for (const auth of action.authorization) {
            hash.update(auth.actor);
            hash.update(auth.permission);
        }
        hash.update(action.data);
        return hash.digest("hex");
    }
}

export type BlockConsumer = (block: ShipBlockResponse) => any;

export default class StateHistoryBlockReader {
    currentArgs: BlockRequestType;
    deltaWhitelist: string[];

    abi: Abi;
    types: Map<string, Serialize.Type>;
    tables: Map<string, string>;

    blocksQueue: PQueue;

    private ws: any;

    private connected: boolean;
    private connecting: boolean;
    private stopped: boolean;

    private deserializeWorkers: StaticPool<(x: Array<{type: string, data: Uint8Array, abi?: any}>) => any>;

    private unconfirmed: number;
    private consumer: BlockConsumer;

    constructor(
        private readonly endpoint: string,
        private options: IBlockReaderOptions = {min_block_confirmation: 1, ds_threads: 4, allow_empty_deltas: false, allow_empty_traces: false, allow_empty_blocks: false}
    ) {
        this.connected = false;
        this.connecting = false;
        this.stopped = true;

        this.blocksQueue = new PQueue({concurrency: 32, autoStart: true});
        this.deserializeWorkers = undefined;

        this.consumer = null;

        this.abi = null;
        this.types = null;
        this.tables = new Map();

        this.deltaWhitelist = [];
    }

    setOptions(options?: IBlockReaderOptions, deltas?: string[]): void {
        if (options) {
            this.options = {...this.options, ...options};
        }

        if (deltas) {
            this.deltaWhitelist = deltas;
        }
    }

    connect(): void {
        if (!this.connected && !this.connecting && !this.stopped) {
            logger.info(`Connecting to ship endpoint ${this.endpoint}`);
            logger.info(`Ship connect options ${JSON.stringify({...this.currentArgs, have_positions: 'removed'})}`);

            this.connecting = true;

            this.ws = new WebSocket(this.endpoint, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 * 1024 });

            this.ws.on('open', () => this.onConnect());
            this.ws.on('message', (data: any) => this.onMessage(data));
            this.ws.on('close', () => this.onClose());
            this.ws.on('error', (e: Error) => { logger.error('Websocket error', e); });
        }
    }

    reconnect(): void {
        if (this.stopped) {
            return;
        }

        setTimeout(() => {
            logger.info('Reconnecting to Ship...');

            this.connect();
        }, 5000);
    }

    send(request: [string, any]): void {
        this.ws.send(serializeEosioType('request', request, this.types));
    }

    onConnect(): void {
        this.connected = true;
        this.connecting = false;
    }

    onMessage(data: any): void {
        try {
            if (!this.abi) {
                logger.info('Receiving ABI from ship...');

                AbiEOS.load_abi("0", data);

                this.abi = JSON.parse(data);
                this.types = getTypesFromAbi(Serialize.createInitialTypes(), this.abi);

                if (this.options.ds_threads > 0) {
                    this.deserializeWorkers = new StaticPool({
                        size: this.options.ds_threads,
                        task: './build/workers/deserializer.js',
                        workerData: {abi: data}
                    });
                }

                for (const table of this.abi.tables) {
                    this.tables.set(table.name, table.type);
                }

                if (!this.stopped) {
                    this.requestBlocks();
                }
            } else {
                const [type, response] = deserializeEosioType('result', data, this.types);

                if (['get_blocks_result_v0', 'get_blocks_result_v1', 'get_blocks_result_v2'].indexOf(type) >= 0) {
                    const config: {[key: string]: {version: number }} = {
                        'get_blocks_result_v0': {version: 0},
                        'get_blocks_result_v1': {version: 1},
                        'get_blocks_result_v2': {version: 2}
                    };

                    let block: any = null;
                    let traces: any = [];
                    let deltas: any = [];

                    if (response.this_block) {
                        if (response.block) {
                            if (config[type].version === 2) {
                                block = this.deserializeParallel('signed_block_variant', response.block)
                                    .then((res: any) => {
                                        if (res[0] === 'signed_block_v1') {
                                            return res[1];
                                        }

                                        throw new Error('Unsupported block type received ' + res[0]);
                                    });
                            } else if (config[type].version === 1) {
                                if (response.block[0] === 'signed_block_v1') {
                                    block = response.block[1];
                                } else {
                                    block = Promise.reject(new Error('Unsupported block type received ' + response.block[0]));
                                }
                            } else if (config[type].version === 0) {
                                block = this.deserializeParallel('signed_block', response.block);
                            } else {
                                block = Promise.reject(new Error('Unsupported result type received ' + type));
                            }
                        } else if(this.currentArgs.fetch_block) {
                            if (this.options.allow_empty_blocks) {
                                logger.warn('Block #' + response.this_block.block_num + ' does not contain block data');
                            } else {
                                logger.error('Block #' + response.this_block.block_num + ' does not contain block data');

                                return this.blocksQueue.pause();
                            }
                        }

                        if (response.traces) {
                            traces = this.deserializeParallel('transaction_trace[]', response.traces);
                        } else if(this.currentArgs.fetch_traces) {
                            if (this.options.allow_empty_traces) {
                                logger.warn('Block #' + response.this_block.block_num + ' does not contain trace data');
                            } else {
                                logger.error('Block #' + response.this_block.block_num + ' does not contain trace data');

                                return this.blocksQueue.pause();
                            }
                        }

                        if (response.deltas) {
                            deltas = this.deserializeParallel('table_delta[]', response.deltas)
                                .then(res => this.deserializeDeltas(res));
                        } else if(this.currentArgs.fetch_deltas) {
                            if (this.options.allow_empty_deltas) {
                                logger.warn('Block #' + response.this_block.block_num + ' does not contain delta data');
                            } else {
                                logger.error('Block #' + response.this_block.block_num + ' does not contain delta data');

                                return this.blocksQueue.pause();
                            }
                        }
                    } else {
                        logger.warn('got null block, maybe indexer finished?');
                        return;
                    }

                    this.blocksQueue.add(async () => {

                        if (response.this_block) {
                            this.currentArgs.start_block_num = response.this_block.block_num + 1;
                        } else {
                            this.currentArgs.start_block_num += 1;
                        }

                        if (response.this_block && response.last_irreversible) {
                            this.currentArgs.have_positions = this.currentArgs.have_positions.filter(
                                row => row.block_num > response.last_irreversible.block_num && row.block_num < response.this_block.block_num
                            );

                            if (response.this_block.block_num > response.last_irreversible.block_num) {
                                this.currentArgs.have_positions.push(response.this_block);
                            }
                        }

                        let deserializedTraces = [];
                        let deserializedDeltas = [];

                        let deserializedBlock = null;
                        let signatures: {[key: string]: string[]} = {};
                        let blockNum = response.this_block.block_num;

                        try {
                            deserializedTraces = await traces;

                        } catch (error) {
                            logger.error('Failed to deserialize traces at block #' + blockNum, error);

                            this.blocksQueue.clear();
                            this.blocksQueue.pause();

                            throw error;
                        }

                        try {
                            deserializedDeltas = await deltas;
                        } catch (error) {
                            logger.error('Failed to deserialize deltas at block #' + blockNum, error);

                            this.blocksQueue.clear();
                            this.blocksQueue.pause();

                            throw error;
                        }

                        try {
                            deserializedBlock = await block;

                            // grab signatures
                            if (deserializedBlock && 'transactions' in deserializedBlock) {
                                for (const tx of deserializedBlock.transactions) {

                                    if (tx.trx[0] !== "packed_transaction")
                                        continue;

                                    const packed_trx = tx.trx[1].packed_trx;
                                    let trx = null;

                                    for (const dsType of DS_TYPES) {
                                    try {
                                        trx = await this.deserializeParallel(dsType, packed_trx);

                                        if (dsType == 'transaction') {
                                            for (const action of trx.actions) {
                                                const txData = tx.trx[1];
                                                const actHash = hashTxAction(action);
                                                if (txData.signatures) {
                                                    signatures[actHash] = txData.signatures;

                                                } else if (txData.prunable_data) {
                                                    const [key, prunableData] = txData.prunable_data.prunable_data;
                                                    if (key !== 'prunable_data_full_legacy')
                                                        continue;

                                                    signatures[actHash] = prunableData.signatures;
                                                }
                                            }
                                        }

                                        break;

                                    } catch (error) {
                                        logger.warn(`attempt to deserialize as ${dsType} failed: ` + getErrorMessage(error));
                                        continue;
                                    }
                                }

                                if (trx == null)
                                    logger.error(`null trx in ${blockNum}`)
                                }
                            }

                        } catch (error) {
                            logger.error('Failed to deserialize block, response: \n' + JSON.stringify(response, null, 4), error);

                            this.blocksQueue.clear();
                            this.blocksQueue.pause();

                            throw error;
                        }

                        try {
                            await this.processBlock({
                                this_block: response.this_block,
                                head: response.head,
                                last_irreversible: response.last_irreversible,
                                prev_block: response.prev_block,
                                block: Object.assign(
                                    {...response.this_block},
                                    deserializedBlock,
                                    {last_irreversible: response.last_irreversible},
                                    {head: response.head},
                                    {signatures: signatures}
                                ),
                                traces: deserializedTraces,
                                deltas: deserializedDeltas
                            });
                        } catch (error) {
                            logger.error('Ship blocks queue stopped due to an error at #' + blockNum, error);

                            this.blocksQueue.clear();
                            this.blocksQueue.pause();

                            throw error;
                        }

                        this.unconfirmed += 1;

                        if (this.unconfirmed >= this.options.min_block_confirmation) {
                            this.send(['get_blocks_ack_request_v0', { num_messages: this.unconfirmed }]);
                            this.unconfirmed = 0;
                        }
                    }).then();
                } else {
                    logger.warn('Not supported message received', {type, response});
                }
            }
        } catch (e) {
            logger.error(e);

            this.ws.close();

            throw e;
        }
    }

    async onClose(): Promise<void> {
        logger.error('Ship Websocket disconnected');

        if (this.ws) {
            await this.ws.terminate();
            this.ws = null;
        }

        this.abi = null;
        this.types = null;
        this.tables = new Map();

        this.connected = false;
        this.connecting = false;

        this.blocksQueue.clear();

        if (this.deserializeWorkers) {
            await this.deserializeWorkers.destroy();
            this.deserializeWorkers = null;
        }

        this.reconnect();
    }

    requestBlocks(): void {
        this.unconfirmed = 0;

        this.send(['get_blocks_request_v0', this.currentArgs]);
    }

    startProcessing(request: BlockRequestType = {}, deltas: string[] = []): void {
        this.currentArgs = {
            start_block_num: 0,
            end_block_num: 0xffffffff,
            max_messages_in_flight: 1,
            have_positions: [],
            irreversible_only: false,
            fetch_block: false,
            fetch_traces: false,
            fetch_deltas: false,
            ...request
        };
        this.deltaWhitelist = deltas;
        this.stopped = false;

        if (this.connected && this.abi) {
            this.requestBlocks();
        }

        this.blocksQueue.start();

        this.connect();
    }

    stopProcessing(): void {
        this.stopped = true;

        this.ws.close();

        this.blocksQueue.clear();
        this.blocksQueue.pause();
    }

    async processBlock(block: ShipBlockResponse): Promise<void> {
        if (!block.this_block) {
            if (this.currentArgs.start_block_num >= this.currentArgs.end_block_num) {
                logger.warn(
                    'Empty block #' + this.currentArgs.start_block_num + ' received. Reader finished reading.'
                );
            } else if (this.currentArgs.start_block_num % 10000 === 0) {
                logger.warn(
                    'Empty block #' + this.currentArgs.start_block_num + ' received. ' +
                    'Node was likely started with a snapshot and you tried to process a block range ' +
                    'before the snapshot. Catching up until init block.'
                );
            }

            return;
        }

        if (this.consumer) {
            await this.consumer(block);
        }

        return;
    }

    consume(consumer: BlockConsumer): void {
        this.consumer = consumer;
    }

    async deserializeParallel(type: string, data: Uint8Array): Promise<any> {
        if (this.options.ds_threads > 0) {
            const result = await this.deserializeWorkers.exec([{type, data}]);

            if (result.success) {
                return result.data[0];
            }

            throw new Error(result.message);
        }

        return deserializeEosioType(type, data, this.types);
    }

    async deserializeArrayParallel(rows: Array<{type: string, data: Uint8Array}>): Promise<any> {
        if (this.options.ds_threads > 0) {
            const result = await this.deserializeWorkers.exec(rows);

            if (result.success) {
                return result.data;
            }

            throw new Error(result.message);
        }

        return rows.map(row => deserializeEosioType(row.type, row.data, this.types));
    }

    private async deserializeDeltas(deltas: any[]): Promise<any> {
        return await Promise.all(deltas.map(async (delta: any) => {
            if (delta[0] === 'table_delta_v0' || delta[0] === 'table_delta_v1') {
                if (this.deltaWhitelist.indexOf(delta[1].name) >= 0) {
                    const deserialized = await this.deserializeArrayParallel(delta[1].rows.map((row: any) => ({
                        type: delta[1].name, data: row.data
                    })));

                    return [
                        delta[0],
                        {
                            ...delta[1],
                            rows: delta[1].rows.map((row: any, index: number) => ({
                                present: !!row.present, data: deserialized[index]
                            }))
                        }
                    ];
                }

                return delta;
            }

            throw Error('Unsupported table delta type received ' + delta[0]);
        }));
    }
}
