import { TextDecoder, TextEncoder } from 'text-encoding';
import { SerialBuffer } from 'eosjs/dist/eosjs-serialize';

import { deserializeUInt, serializeUInt } from './binary';
import { Serialize } from 'eosjs';
import { ShipTableDelta, ShipTransactionTrace } from '../types/ship';
import { EosioActionTrace, EosioContractRow, EosioTransaction } from '../types/eosio';
import { Abi } from 'eosjs/dist/eosjs-rpc-interfaces';

function charToSymbol(c: any) {
    if (typeof c == 'string') c = c.charCodeAt(0);

    if (c >= 'a'.charCodeAt(0) && c <= 'z'.charCodeAt(0)) {
      return c - 'a'.charCodeAt(0) + 6;
    }

    if (c >= '1'.charCodeAt(0) && c <= '5'.charCodeAt(0)) {
      return c - '1'.charCodeAt(0) + 1;
    }

    return 0;
}

export function nameToUint64(name: any) {
    let n = BigInt(0);

    let i = 0;
    for (; i < 12 && name[i]; i++) {
      n |= BigInt(charToSymbol(name.charCodeAt(i)) & 0x1f) << BigInt(64 - 5 * (i + 1));
    }

    if (i == 12) {
      n |= BigInt(charToSymbol(name.charCodeAt(i)) & 0x0f);
    }

    return n.toString();
}

export function serializeEosioName(name: string): string {
    const buffer = new SerialBuffer({textEncoder: new TextEncoder(), textDecoder: new TextDecoder()});

    buffer.pushName(name);

    const bytes = buffer.asUint8Array();
    let n = BigInt(0);

    for (const byte of bytes) {
        n = (n << BigInt(8)) + BigInt(byte);
    }

    return serializeUInt(n).toString();
}

export function deserializeEosioName(data: string): string {
    const bytes = new Uint8Array(8);
    let n = deserializeUInt(data);

    for (let i = 0; i < 8; i ++) {
        bytes[7 - i] = Number(n & BigInt(0xFF));
        n = n >> BigInt(8);
    }

    const buffer = new SerialBuffer({textEncoder: new TextEncoder(), textDecoder: new TextDecoder(), array: bytes});

    return buffer.getName();
}

export function eosioTimestampToDate(timestamp: string): Date {
    return new Date(timestamp + '+0000');
}

export function splitEosioToken(asset: string, contract?: string): {amount: string, token_symbol: string, token_precision: number, token_contract?: string} {
    const split1 = asset.split(' ');
    const split2 = split1[0].split('.');

    return {
        amount: split2.join(''),
        token_symbol: split1[1],
        token_precision: split2[1] ? split2[1].length : 0,
        token_contract: contract
    };
}

export function deserializeEosioType(type: string, data: Uint8Array | string, types: Map<string, Serialize.Type>, checkLength: boolean = true): any {
    let dataArray;
    if (typeof data === 'string') {
        dataArray = Uint8Array.from(Buffer.from(data, 'hex'));
    } else {
        dataArray = new Uint8Array(data);
    }

    const buffer = new Serialize.SerialBuffer({ textEncoder: new TextEncoder(), textDecoder: new TextDecoder(), array: dataArray });
    const result = Serialize.getType(types, type).deserialize(buffer, new Serialize.SerializerState({ bytesAsUint8Array: true }));

    if (buffer.readPos !== data.length && checkLength) {
        throw new Error('Deserialization error: ' + type);
    }

    return result;
}

export function serializeEosioType(type: string, value: any, types: Map<string, Serialize.Type>): Uint8Array {
    const buffer = new Serialize.SerialBuffer({ textEncoder: new TextEncoder(), textDecoder: new TextDecoder() });
    Serialize.getType(types, type).serialize(buffer, value);

    return buffer.asUint8Array();
}

export function extractShipTraces(data: ShipTransactionTrace[]): Array<{trace: EosioActionTrace<any>, tx: EosioTransaction<any>}> {
    const transactions: EosioTransaction[] = [];

    for (const transaction of data) {
        if (transaction[0] === 'transaction_trace_v0') {
            if (transaction[1].status !== 0) {
                continue;
            }

            transactions.push({
                id: transaction[1].id,
                cpu_usage_us: transaction[1].cpu_usage_us,
                net_usage_words: transaction[1].net_usage_words,
                traces: transaction[1].action_traces.map(trace => {
                    if (trace[0] === 'action_trace_v0' || trace[0] === 'action_trace_v1') {
                        if (trace[1].receiver !== trace[1].act.account) {
                            return null;
                        }

                        return {
                            action_ordinal: trace[1].action_ordinal,
                            creator_action_ordinal: trace[1].creator_action_ordinal,
                            global_sequence: trace[1].receipt[1].global_sequence,
                            account_ram_deltas: trace[1].account_ram_deltas,
                            act: {
                                account: trace[1].act.account,
                                name: trace[1].act.name,
                                authorization: trace[1].act.authorization,
                                data: trace[1].act.data
                            },
                            console: trace[1].console
                        };
                    }

                    throw new Error('Invalid action trace type ' + trace[0]);
                }).filter(trace => !!trace).sort((a, b) => {
                    return parseInt(a.global_sequence, 10) - parseInt(b.global_sequence, 10);
                })
            });
        } else {
            throw new Error('Unsupported transaction response received: ' + transaction[0]);
        }
    }

    const result: Array<{trace: EosioActionTrace<any>, tx: EosioTransaction<any>}> = [];

    for (const tx of transactions) {
        for (const trace of tx.traces) {
            result.push({trace, tx});
        }
    }

    result.sort((a, b) => {
        return parseInt(a.trace.global_sequence, 10) - parseInt(b.trace.global_sequence, 10);
    });

    return result;
}

export function extractShipContractRows(deltas: ShipTableDelta[]): Array<EosioContractRow<any>> {
    const result: EosioContractRow<any>[] = [];

    for (const delta of deltas) {
        if (delta[0] === 'table_delta_v0' || delta[0] === 'table_delta_v1') {
            if (delta[1].name === 'contract_row') {
                for (const row of delta[1].rows) {
                    if (row.data[0] === 'contract_row_v0') {
                        result.push({...row.data[1], present: !!row.present});
                    } else {
                        throw new Error('Unsupported contract row received: ' + row.data[0]);
                    }
                }
            }
        } else {
            throw new Error('Unsupported table delta response received: ' + delta[0]);
        }
    }

    return result;
}

export function extractGlobalContractRow(deltas: ShipTableDelta[]): EosioContractRow<any> {
    for (const delta of deltas) {
        if (delta[0] === 'table_delta_v0' || delta[0] === 'table_delta_v1') {
            if (delta[1].name === 'contract_row') {
                for (const row of delta[1].rows) {
                    if (row.data[0] === 'contract_row_v0') {
                        const dt: EosioContractRow<any> = {...row.data[1], present: !!row.present};
                        if (dt.code == 'eosio' && dt.scope == 'eosio' && dt.table == 'global')
                            return dt;
                    } else {
                        throw new Error('Unsupported contract row received: ' + row.data[0]);
                    }
                }
            }
        } else {
            throw new Error('Unsupported table delta response received: ' + delta[0]);
        }
    }

    return null; 
}

export function getTableAbiType(abi: Abi, contract: string, table: string): string {
    for (const row of abi.tables) {
        if (row.name === table) {
            return row.type;
        }
    }

    throw new Error('Type for table not found ' + contract + ':' + table);
}

export function getActionAbiType(abi: Abi, contract: string, action: string): string {
    for (const row of abi.actions) {
        if (row.name === action) {
            return row.type;
        }
    }

    throw new Error('Type for action not found ' + contract + ':' + action);
}

export function parseAsset(s: string) {
    if (typeof s !== 'string') {
        throw new Error('Expected string containing asset');
    }
    s = s.trim();
    let pos = 0;
    let amount = '';
    let precision = 0;
    if (s[pos] === '-') {
        amount += '-';
        ++pos;
    }
    let foundDigit = false;
    while (pos < s.length && s.charCodeAt(pos) >= '0'.charCodeAt(0) && s.charCodeAt(pos) <= '9'.charCodeAt(0)) {
        foundDigit = true;
        amount += s[pos];
        ++pos;
    }
    if (!foundDigit) {
        throw new Error('Asset must begin with a number');
    }
    if (s[pos] === '.') {
        ++pos;
        while (pos < s.length && s.charCodeAt(pos) >= '0'.charCodeAt(0) && s.charCodeAt(pos) <= '9'.charCodeAt(0)) {
            amount += s[pos];
            ++precision;
            ++pos;
        }
    }
    const name = s.substr(pos).trim();

    return {
        amount: amount,
        precision: precision,
        symbol: name
    };
}


import { JsonRpc } from 'eosjs';
import { IndexerConfig } from '../types/indexer';

// @ts-ignore
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

export function getRPCClient(config: IndexerConfig) {
    return new JsonRpc(config.endpoint, { fetch });
}
