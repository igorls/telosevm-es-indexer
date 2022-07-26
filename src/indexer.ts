import StateHistoryBlockReader from './ship';
import {
    ShipBlockResponse
} from './types/ship';

import { StaticPool } from 'node-worker-threads-pool';

import { IndexerConfig } from './types/indexer';

import {
    extractGlobalContractRow,
    extractShipTraces,
    deserializeEosioType,
    getTableAbiType,
    getActionAbiType,
    getRPCClient
} from './utils/eosio';

import { removeHexPrefix } from './utils/evm';

import * as eosioEvmAbi from './abis/evm.json'
import * as eosioTokenAbi from './abis/token.json'
import * as eosioSystemAbi from './abis/system.json'

import logger from './utils/winston';

import { Serialize , RpcInterfaces, JsonRpc } from 'eosjs';

import { 
    setCommon,
    handleEvmTx, handleEvmDeposit, handleEvmWithdraw
} from './handlers';

import {StorageEosioAction, StorageEvmTransaction} from './types/evm';
import RPCBroadcaster from './publisher';

import { hashTxAction } from './ship';
import {ElasticConnector} from './database/connector';

const createKeccakHash = require('keccak');

function getContract(contractAbi: RpcInterfaces.Abi) {
    const types = Serialize.getTypesFromAbi(Serialize.createInitialTypes(), contractAbi)
    const actions = new Map()
    for (const { name, type } of contractAbi.actions) {
        actions.set(name, Serialize.getType(types, type))
    }
    return { types, actions }
}



const deltaType = getTableAbiType(eosioSystemAbi.abi, 'eosio', 'global');

export class TEVMIndexer {
    endpoint: string;
    wsEndpoint: string;
    contracts: {[key: string]: Serialize.Contract};
    abis: {[key: string]: RpcInterfaces.Abi};

    startBlock: number;
    stopBlock: number;

    txsSinceLastReport: number = 0;

    config: IndexerConfig;

    hasher: StaticPool<(x: {type: string, params: any}) => any>;
    reader: StateHistoryBlockReader;
    broadcaster: RPCBroadcaster;
    rpc: JsonRpc;
    connector: ElasticConnector; 
    
    constructor(telosConfig: IndexerConfig) {
        this.config = telosConfig;

        this.endpoint = telosConfig.endpoint;
        this.wsEndpoint = telosConfig.wsEndpoint;
        this.startBlock = telosConfig.startBlock;
        this.stopBlock = telosConfig.stopBlock;

        this.broadcaster = new RPCBroadcaster(telosConfig.broadcast);
        this.rpc = getRPCClient(telosConfig);
        this.connector = new ElasticConnector(
            telosConfig.chainName, telosConfig.elastic); 

        this.reader = new StateHistoryBlockReader(this.wsEndpoint);
        this.reader.setOptions({
            min_block_confirmation: 1,
            ds_threads: telosConfig.perf.workerAmount,
            allow_empty_deltas: true,
            allow_empty_traces: true,
            allow_empty_blocks: true
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
        
        setCommon(telosConfig.chainId);
    }

    async consumer(resp: ShipBlockResponse): Promise<void> {
        const currentBlock = resp.this_block.block_num;

        // process deltas to catch evm block num
        const globalDelta = extractGlobalContractRow(resp.deltas);
        const eosioGlobalState = deserializeEosioType(
            deltaType, globalDelta.value, this.contracts['eosio'].types);

        const evmBlockNumber = eosioGlobalState.block_num;
        const evmTransactions: Array<{
            trx_id: string,
            action_ordinal: number,
            signatures: string[],
            evmTx: StorageEvmTransaction
        }> = [];
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
                if (actionHash in resp.block.signatures) {
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
                logger.error(JSON.stringify(resp.block.signatures, null, 4));
                throw new Error();
            }

            const signature = resp.block.signatures[actionHash][0];

            let evmTx: StorageEvmTransaction = null;
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
                        signature,
                        this.rpc
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
                logger.warn(`null evmTx in block: ${currentBlock}`);
                continue;
            }

            evmTransactions.push({
                trx_id: tx.tx.id,
                action_ordinal: tx.trace.action_ordinal,
                signatures: resp.block.signatures[actionHash],
                evmTx: evmTx
            });
            this.txsSinceLastReport++; 
        }

        const hasherResp = await this.hasher.exec({
            type: 'block', params: {
                nativeBlockNumber: currentBlock,
                evmBlockNumber: eosioGlobalState.block_num,
                blockTimestamp: resp.block.timestamp,
                evmTxs: evmTransactions
            }});

        if (!hasherResp.success) {
            logger.error(hasherResp);
            process.exit(1);
        }

        if (currentBlock % 1000 == 0) {
            logger.info(`${currentBlock} indexed, ${this.txsSinceLastReport} txs.`)
            this.txsSinceLastReport = 0;
        }
        
    }

    async launch() {

        let startBlock = this.startBlock;
        let stopBlock = this.stopBlock;
        let prevHash = null;

        let connected = false;
        while (!connected) {
            try {
                await this.connector.init();
                connected = true;
            } catch (error) {
                logger.error(error);
            }
        }

        logger.info('checking db for blocks...');
        const lastBlock = await this.connector.getLastIndexedBlock();

        if (lastBlock != null) {
            logger.info(JSON.stringify(lastBlock, null, 4));
            startBlock = lastBlock.block_num;
            prevHash = lastBlock['@evmBlockHash'];
            logger.info(
                `found! ${startBlock} produced on ${lastBlock['@timestamp']} with hash ${prevHash}`);

        } else {
            prevHash = createKeccakHash('keccak256')
                .update(this.config.chainId.toString(16))
                .digest('hex');
            logger.info(`not found, start from ${startBlock} with hash ${prevHash}.`);
        }

        this.hasher = new StaticPool({
            size: 1,
            task: './build/workers/hasher.js',
            workerData: {
                chainName: this.config.chainName,
                chainId: this.config.chainId,
                elasticConf: this.config.elastic,
                startBlock: startBlock,
                prevHash: prevHash 
            }
        });

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

    }

};
