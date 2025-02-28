import PQueue from 'p-queue';
import { Serialize , RpcInterfaces, JsonRpc } from 'eosjs';
import { Abi } from 'eosjs/dist/eosjs-rpc-interfaces';
import { StaticPool } from 'node-worker-threads-pool';

import * as eosioEvmAbi from './abis/evm.json'
import * as eosioMsigAbi from './abis/msig.json';
import * as eosioTokenAbi from './abis/token.json'
import * as eosioSystemAbi from './abis/system.json'

import logger from './utils/winston';
import {
    BlockRequestType,
    IBlockReaderOptions, ShipBlockResponse
} from './types/ship';

import {
    extractGlobalContractRow,
    extractShipTraces,
    deserializeEosioType,
    serializeEosioType,
    getTableAbiType,
    getActionAbiType,
    getRPCClient
} from './utils/eosio';

import { getTypesFromAbi } from './utils/serialize';

import { BlockConsumer, DS_TYPES, EVMTxWrapper, getContract, getErrorMessage, hashTxAction, ProcessedBlock } from './utils/evm';

import {StorageEvmTransaction} from './types/evm';

import * as AbiEOS from "@eosrio/node-abieos";

import { 
    setCommon,
    handleEvmTx, handleEvmDeposit, handleEvmWithdraw,
    TxDeserializationError, isTxDeserializationError
} from './handlers';
import {IndexerState} from './types/indexer';
import {TEVMIndexer} from './indexer';

import WebSocket from 'ws';


const deltaType = getTableAbiType(eosioSystemAbi.abi, 'eosio', 'global');

interface InprogressBuffers {
    evmTransactions: Array<EVMTxWrapper>;
    errors: TxDeserializationError[];
    evmBlockNum: number;
};


export default class StateHistoryBlockReader {
    currentArgs: BlockRequestType;

    abi: Abi;
    types: Map<string, Serialize.Type>;
    tables: Map<string, string>;

    blocksQueue: PQueue;

    rpc: JsonRpc;

    // debug info
    headBlock: number;
    currentBlock: number;

    private ws: WebSocket;
    private deserializeWorkers: StaticPool<
        (x: Array<{type: string, data: Uint8Array, abi?: any}>) => any>;

    private unconfirmed: number;

    private limboBuffs: InprogressBuffers = null;

    private contracts: {[key: string]: Serialize.Contract};
    private abis: {[key: string]: RpcInterfaces.Abi};

    private mustReconnect: boolean = true;

    constructor(
        private readonly indexer: TEVMIndexer,
        private options: IBlockReaderOptions
    ) {
        this.blocksQueue = new PQueue({
            concurrency: indexer.config.perf.concurrencyAmount,
            autoStart: true
        });

        this.deserializeWorkers = undefined;

        this.abi = null;
        this.types = null;
        this.tables = new Map();

        this.abis = {
            'eosio.evm': eosioEvmAbi.abi,
            'eosio.msig': eosioMsigAbi.abi,
            'eosio.token': eosioTokenAbi.abi,
            'eosio': eosioSystemAbi.abi
        };
        this.contracts = {
            'eosio.evm': getContract(eosioEvmAbi.abi),
            'eosio.msig': getContract(eosioMsigAbi.abi),
            'eosio.token': getContract(eosioTokenAbi.abi),
            'eosio': getContract(eosioSystemAbi.abi)
        };

        this.rpc = getRPCClient(indexer.config);
        setCommon(indexer.config.chainId);
    }

    connect(): void {
        logger.info(`Connecting to ship endpoint ${this.indexer.config.wsEndpoint}`);
        logger.info(`Ship connect options ${JSON.stringify({...this.currentArgs, have_positions: 'removed'})}`);

        this.ws = new WebSocket(
            this.indexer.config.wsEndpoint, {
                perMessageDeflate: false,
                maxPayload: 512 * 1024 * 1024 * 1024
        })
            .on('open', () => logger.info('Websocket connected.'))
            .on('message', (data: any) => this.onMessage(data))
            .on('close', async () => {
                logger.info('Websocket disconnected.');
                if (this.mustReconnect)
                    await this.reconnect();
            })
            .on('error', (e: Error) => { logger.error('Websocket error', e); });
    }

    async reconnect(): Promise<void> {
        if (this.ws) {
            this.ws.terminate();
            this.ws = null;
        }
        this.abi = null;
        this.types = null;
        this.tables = new Map();

        if (this.deserializeWorkers) {
            await this.deserializeWorkers.destroy();
            this.deserializeWorkers = null;
        }

        logger.warn('Reconnecting websocket...');
        this.connect();
    }

    send(request: [string, any]): void {
        this.ws.send(serializeEosioType('request', request, this.types));
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

                this.requestBlocks();

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

                    const blockConsumeTask = async () => {

                        this.headBlock = response.head.block_num;
                        this.currentBlock = response.this_block.block_num;

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
                    };

                    if (this.indexer.state == IndexerState.HEAD)
                        setTimeout(blockConsumeTask, 0);
                    else
                        this.blocksQueue.add(blockConsumeTask).then();

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

    finishBlock() {
        if (this.unconfirmed >= this.options.min_block_confirmation) {
            logger.debug(`Sending ack for ${this.unconfirmed} blocks.`);
            this.send(['get_blocks_ack_request_v0', { num_messages: this.unconfirmed }]);
            this.unconfirmed = 0;
        }
    }

    requestBlocks(): void {
        this.unconfirmed = 0;
        logger.debug(`Request blocks ${this.currentArgs.start_block_num}`);
        this.send(['get_blocks_request_v0', this.currentArgs]);
    }

    startProcessing(request: BlockRequestType = {}): void {
        this.mustReconnect = true;
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

        this.blocksQueue.start();

        this.connect();
    }

    stopProcessing(): void {
        this.mustReconnect = false;
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

        if (this.indexer.state == IndexerState.SYNC)
            this.handleStateSwitch(block);

        const currentBlock = block.this_block.block_num;

        // process deltas to catch evm block num
        const globalDelta = extractGlobalContractRow(block.deltas);

        let buffs: InprogressBuffers = null;

        if (globalDelta != null) {
            const eosioGlobalState = deserializeEosioType(
                deltaType, globalDelta.value, this.contracts['eosio'].types);

            const currentEvmBlock = eosioGlobalState.block_num;

            buffs = {
                evmTransactions: [],
                errors: [],
                evmBlockNum: currentEvmBlock
            };

            if (this.limboBuffs != null) {
                for (const evmTx of this.limboBuffs.evmTransactions)
                    evmTx.evmTx.block = currentEvmBlock;

                buffs.evmTransactions = this.limboBuffs.evmTransactions
                buffs.errors = this.limboBuffs.errors;
                this.limboBuffs = null;
            }
        } else {
            logger.warn(`onblock failed at block ${currentBlock}`);

            if (this.limboBuffs == null) {
                this.limboBuffs = {
                    evmTransactions: [],
                    errors: [],
                    evmBlockNum: 0
                };
            }

            buffs = this.limboBuffs;
        }

        const evmBlockNum = buffs.evmBlockNum;
        const evmTransactions = buffs.evmTransactions;
        const errors = buffs.errors;

        // traces
        const transactions = extractShipTraces(block.traces);
        let gasUsedBlock: string;
        const systemAccounts = [ 'eosio', 'eosio.stake', 'eosio.ram' ];
        const contractWhitelist = [
            "eosio.evm", "eosio.token",  // evm
            "eosio.msig"  // deferred transaction sig catch
        ];
        const actionWhitelist = [
            "raw", "withdraw", "transfer",  // evm
            "exec" // msig deferred sig catch
        ]

        for (const tx of transactions) {

            const action = tx.trace.act;

            if (!contractWhitelist.includes(action.account) ||
                !actionWhitelist.includes(action.name))
                continue;

            const type = getActionAbiType(
                this.abis[action.account],
                action.account, action.name);

            const actionData = deserializeEosioType(
                type, action.data, this.contracts[action.account].types);

            // discard transfers to accounts other than eosio.evm
            // and transfers from system accounts
            if ((action.name == "transfer" && actionData.to != "eosio.evm") ||
               (action.name == "transfer" && actionData.from in systemAccounts))
                continue;

            // find correct auth in related traces list
            let foundSig = false;
            let actionHash = "";
            for (const trace of tx.tx.traces) {
                actionHash = hashTxAction(trace.act);
                if (actionHash in block.block.signatures) {
                    foundSig = true;
                    break;
                }
            }

            let evmTx: StorageEvmTransaction | TxDeserializationError = null;
            if (action.account == "eosio.evm") {
                if (action.name == "raw") {
                    evmTx = await handleEvmTx(
                        block.this_block.block_id,
                        evmTransactions.length,
                        evmBlockNum,
                        actionData,
                        tx.trace.console
                    );
                    if (!isTxDeserializationError(evmTx))
                        gasUsedBlock = evmTx.gasusedblock;
                } else if (action.name == "withdraw"){
                    evmTx = await handleEvmWithdraw(
                        block.this_block.block_id,
                        evmTransactions.length,
                        evmBlockNum,
                        actionData,
                        this.rpc,
                        gasUsedBlock
                    );
                }
            } else if (action.account == "eosio.token" &&
                    action.name == "transfer" &&
                    actionData.to == "eosio.evm") {
                evmTx = await handleEvmDeposit(
                    block.this_block.block_id,
                    evmTransactions.length,
                    evmBlockNum,
                    actionData,
                    this.rpc,
                    gasUsedBlock
                );
            } else
                continue;

            if (isTxDeserializationError(evmTx)) {
                if (this.indexer.config.debug) {
                    errors.push(evmTx);
                    continue;
                } else {
                    logger.error(evmTx.info.error);
                    throw new Error(JSON.stringify(evmTx));
                }
            }

            let signatures: string[] = [];
            if (foundSig)
                signatures = block.block.signatures[actionHash];

            evmTransactions.push({
                trx_id: tx.tx.id,
                action_ordinal: tx.trace.action_ordinal,
                signatures: signatures,
                evmTx: evmTx
            });
        }

        if (globalDelta) {
            await this.indexer.consumer(new ProcessedBlock({
                nativeBlockHash: block.block.block_id,
                nativeBlockNumber: currentBlock,
                evmBlockNumber: evmBlockNum,
                blockTimestamp: block.block.timestamp,
                evmTxs: evmTransactions,
                errors: errors
            }));
        }

    }

    private handleStateSwitch(resp: ShipBlockResponse) {
        // SYNC & HEAD mode swtich detection
        const blocksUntilHead = resp.head.block_num - this.indexer.lastOrderedBlock;

        if (blocksUntilHead <= 100) {
            this.indexer.state = IndexerState.HEAD;
            this.indexer.connector.state = IndexerState.HEAD;

            logger.info(
                'switched to HEAD mode! blocks will be written to db asap.');
        }
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
                if (this.options.delta_whitelist.indexOf(delta[1].name) >= 0) {
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
};
