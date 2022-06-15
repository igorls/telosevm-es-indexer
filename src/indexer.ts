import StateHistoryBlockReader from './ship';
import {
    ShipBlockResponse
} from './types/ship';

import {
    EosioAction
} from './types/eosio';

import { IndexerConfig } from './types/indexer';

import {
    extractShipContractRows,
    extractShipTraces,
    deserializeEosioType,
    getTableAbiType,
    getActionAbiType,
    getRPCClient
} from './utils/eosio';

import * as eosioEvmAbi from './abis/evm.json'
import * as eosioTokenAbi from './abis/token.json'
import * as eosioSystemAbi from './abis/system.json'

import logger from './utils/winston';

import { Serialize , RpcInterfaces, JsonRpc } from 'eosjs';

import { handleEvmTx, handleEvmDeposit, handleEvmWithdraw } from './handlers';

import { ElasticConnector } from './database/connector';

const createHash = require("sha1-uint8array").createHash

const encoder = new TextEncoder;
const decoder = new TextDecoder;


function getContract(contractAbi: RpcInterfaces.Abi) {
    const types = Serialize.getTypesFromAbi(Serialize.createInitialTypes(), contractAbi)
    const actions = new Map()
    for (const { name, type } of contractAbi.actions) {
        actions.set(name, Serialize.getType(types, type))
    }
    return { types, actions }
}

function deserialize(types: Map<string, Serialize.Type>, array: Uint8Array, typeName: string) {
    const buffer = new Serialize.SerialBuffer(
        { textEncoder: encoder, textDecoder: decoder, array });

    let result = Serialize.getType(types, typeName)
        .deserialize(buffer, new Serialize.SerializerState({ bytesAsUint8Array: true }));

    return result;
}


function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

const debug = false;
function hashTxAction(action: EosioAction) {
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


export class TEVMIndexer {
    endpoint: string;
    wsEndpoint: string;
    contracts: {[key: string]: Serialize.Contract};
    abis: {[key: string]: RpcInterfaces.Abi};

    currentBlock: number;
    startBlock: number;
    stopBlock: number;
    headBlock: number;
    lastIrreversibleBlock: number;
    txsSinceLastReport: number = 0;

    lastCommittedBlock: number;
    blocksUntilHead: number;

    config: IndexerConfig;

    reader: StateHistoryBlockReader;
    connector: ElasticConnector;
    rpc: JsonRpc;
    
    constructor(telosConfig: IndexerConfig) {
        this.config = telosConfig;

        this.endpoint = telosConfig.endpoint;
        this.wsEndpoint = telosConfig.wsEndpoint;
        this.startBlock = telosConfig.startBlock;
        this.stopBlock = telosConfig.stopBlock;

        this.connector = new ElasticConnector(telosConfig.elastic);
        this.rpc = getRPCClient(telosConfig);

        this.reader = new StateHistoryBlockReader(this.wsEndpoint);
        this.reader.setOptions({
            min_block_confirmation: 1,
            ds_threads: telosConfig.perf.workerAmount,
            allow_empty_deltas: false,
            allow_empty_traces: false,
            allow_empty_blocks: false
        });

        this.abis = {
            'eosio.evm': eosioEvmAbi.abi,
            'eosio.token': eosioTokenAbi.abi,
            'eosio': eosioSystemAbi.abi
        };
        this.contracts = {
            'eosio.evm': getContract(eosioEvmAbi.abi),
            'eosio.token': getContract(eosioTokenAbi.abi),
            'eosio': getContract(eosioSystemAbi.abi)
        };
    }

    async consumer(resp: ShipBlockResponse): Promise<void> {
        if (resp.this_block.block_num > this.currentBlock + 1) {
            throw new Error('Skipped a block ' + JSON.stringify({
                expected: this.currentBlock + 1,
                processed: resp.this_block.block_num
            }));
        }

        const blocksUntilHead = resp.last_irreversible.block_num - resp.this_block.block_num;

        if (resp.this_block.block_num <= this.currentBlock) {
            if (resp.this_block.block_num < this.lastIrreversibleBlock) {
                throw new Error('Dont rollback more blocks than are reversible');
            }

            logger.info('Chain fork detected. Reverse all blocks which were affected');
            
            // TODO
        }

        this.currentBlock = resp.this_block.block_num;
        this.headBlock = resp.head.block_num;
        this.lastIrreversibleBlock = resp.last_irreversible.block_num;
        this.blocksUntilHead = blocksUntilHead;

        let signatures: {[key: string]: string[]} = {};

        for (const tx of resp.block.transactions) {

            if (tx.trx[0] !== "packed_transaction")
                continue;

            const packed_trx = tx.trx[1].packed_trx;
            const dsTypes = [ // deserialization types
                'transaction',
                'code_v0',
                'account_metadata_v0',
                'account_v0',
                'contract_table_v0',
                'contract_row_v0',
                'contract_index64_v0',
                'contract_index128_v0',
                'contract_index256_v0',
                'contract_index_double_v0',
                'contract_index_long_double_v0',
            ];
            let trx = null;

            for (const dsType of dsTypes) {
                try {
                    trx = deserialize(
                        this.reader.types, packed_trx, dsType);

                    if (dsType == 'transaction') {
                        for (const action of trx.actions) {
                            signatures[hashTxAction(action)] = tx.trx[1].signatures;
                        }
                    }

                    break;

                } catch (error) {
                    logger.warn(`attempt to deserialize as ${dsType} failed: ` + getErrorMessage(error));
                    continue;
                }
            }

            if (trx == null) {
                logger.error(`block_num: ${this.currentBlock}`)
                logger.error('unexpected error caught, please consult devs');
                process.exit(1);
            }
        }

        // process deltas to catch evm block num
        let eosioGlobalState = null;
        const contractDeltas = extractShipContractRows(resp.deltas);
        for (const delta of contractDeltas) {
            if (delta.code == "eosio" &&
                delta.scope == "eosio" &&
                delta.table == "global") {

                const type = getTableAbiType(eosioSystemAbi.abi, delta.code, delta.table);
                eosioGlobalState = deserializeEosioType(
                    type,
                    delta.value,
                    this.contracts[delta.code].types);
            }
        }

        if (eosioGlobalState == null)
            throw new Error("Couldn't get eosio global state table delta.");

        const evmBlockNumber = eosioGlobalState.block_num;
        const evmTransactions = [];
        // traces
        const transactions = extractShipTraces(resp.traces);

        for (const tx of transactions) {
            const contractWhitelist = ["eosio.evm", "eosio.token"];
            const actionWhitelist = ["raw", "withdraw", "transfer"]

            const action = tx.trace.act;

            if (!contractWhitelist.includes(action.account) ||
                !actionWhitelist.includes(action.name))
                continue;

            const type = getActionAbiType(
                this.abis[action.account],
                action.account, action.name);

            const actionData = deserializeEosioType(
                type, action.data, this.contracts[action.account].types);

            if (action.name == "transfer" && actionData.to != "eosio.evm")
                continue;

            // find correct auth in related traces list
            let foundSig = false;
            let actionHash = "";
            for (const trace of tx.tx.traces) {
                actionHash = hashTxAction(trace.act);
                if (actionHash in signatures) {
                    foundSig = true;
                    break;
                }
            }

            if (!foundSig) {
                logger.info(JSON.stringify(tx, null, 4));
                logger.error('Couldn\'t find signature that matches trace:');
                logger.error('action: ' + JSON.stringify(action));
                logger.error('actionData: ' + JSON.stringify(actionData));
                logger.error('hash:   ' + JSON.stringify(actionHash));
                logger.error('signatures:');
                logger.error(JSON.stringify(signatures, null, 4));
                throw new Error();
            }

            const signature = signatures[actionHash][0];

            let evmTx = null;
            if (action.account == "eosio.evm") {
                if (action.name == "raw") {
                    evmTx = await handleEvmTx(
                        evmBlockNumber,
                        actionData,
                        signature,
                        tx.trace.console
                    );
                } else if (action.name == "withdraw" ){
                    evmTx = await handleEvmWithdraw(
                        evmBlockNumber,
                        actionData,
                        signature
                    );
                }
            } else if (action.account == "eosio.token" &&
                    action.name == "transfer" &&
                    actionData.to == "eosio.evm") {
                    evmTx = await handleEvmDeposit(
                        evmBlockNumber,
                        actionData,
                        signature,
                        this.rpc
                    );
            } else
                continue;

            if (evmTx == null) {
                logger.error(`null evmTx in block: ${this.currentBlock}`);
                continue;
            }

            evmTransactions.push(evmTx);
            
        }

        if (evmTransactions.length > 0) {
            const storableActions = [];
            for (const evmTx of evmTransactions) {
                storableActions.push({
                    "@timestamp": resp.block.timestamp,
                    "@raw": evmTx
                });
                this.txsSinceLastReport++;
            }
            await this.connector.indexBlock(
                this.currentBlock,
                storableActions,
                {
                    "@timestamp": resp.block.timestamp,
                    "@global": {
                        "block_num": eosioGlobalState.block_num
                    },
                    "@evmBlockHash": "0x00"
                }
            );
        }

        if (this.currentBlock % 1000 == 0) {
            logger.info(`${this.currentBlock} indexed, ${this.txsSinceLastReport} txs.`)
            this.txsSinceLastReport = 0;
        }

    }

    async launch() {
        let prevState = null;

        let startBlock = this.startBlock;
        let stopBlock = this.stopBlock;

        await this.connector.init();
            
        prevState = await this.connector.getIndexerState();

        if (prevState) {
            logger.info(JSON.stringify(prevState, null, 4));

            startBlock = parseInt(prevState.lastIndexedBlock, 10);
        }

        this.reader.consume(this.consumer.bind(this));

        this.reader.startProcessing({
            start_block_num: startBlock,
            end_block_num: stopBlock,
            max_messages_in_flight: this.config.perf.maxMsgsInFlight,
            irreversible_only: true,
            have_positions: [],
            fetch_block: true,
            fetch_traces: true,
            fetch_deltas: true
        }, ['contract_row', 'contract_table']);

        process.on('SIGINT', this.sigintHandler.bind(this));
    }

    sigintHandler() {
        logger.info("interrupt caught, saving state to db...");

        const state = {
            timestamp: new Date().toISOString(),
            lastIndexedBlock: this.currentBlock
        };

        this.connector.indexState(state).then(() => {
            process.exit(0);
        }); 
    }

};
