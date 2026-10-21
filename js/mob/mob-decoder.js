// .MOB / .PRO binary field decoder.

import {
  MOB_FIELD_NAMES,
  MOB_FLAG_BITS,
  MOB_GROUP_BEGIN,
  MOB_GROUP_PARENT_LAST,
  MOB_OD_NAMES,
  MOB_OD_TYPES,
  MOB_RESISTANCE_LABELS,
  MOB_TYPE_LAST_FIELD,
  MOB_TYPE_RANGE_BEGIN,
  MOB_TYPE_RANGE_END,
  MOB_TYPE_RANGE_OFFSET,
} from './mob-schema.js';
import { protoCritterAidInfo, protoCurrentAidArtId } from '../proto/critter-aid.js';
import { SCR_ATTACHMENT_POINTS } from '../scr/scr-schema.js';

function mobDecodeFlagBits(field, num) {
  const table = MOB_FLAG_BITS[field];
  if (!table || typeof num !== 'number') return null;
  const set = table.filter(([mask]) => ((num & mask) >>> 0) === (mask >>> 0)).map(([, name]) => name);
  const known = table.reduce((acc, [mask]) => acc | mask, 0);
  const leftover = num & ~known;
  let text = set.length ? set.join(', ') : '(none of the known bits set)';
  if (leftover) text += ` [+ unrecognized bits: 0x${(leftover >>> 0).toString(16)}]`;
  return text;
}

// Field-aware value formatter: wraps mobValueText but adds a human-readable
// flag breakdown for known bitmask fields, and resistance-type labels for
// F_RESISTANCE array elements.
export function mobFieldValueText(field, value) {
  if (MOB_FLAG_BITS[field] && typeof value === 'number') {
    const decoded = mobDecodeFlagBits(field, value);
    return decoded ? `${value} (${decoded})` : mobValueText(value);
  }
  if (field === 31 && value && value.elements) { // F_RESISTANCE
    const lines = [`element_size=${value.element_size}`, `count=${value.count}`, `bitset_id=${value.bitset_id}`, `bitset=${value.bitset.join(' ')}`, 'elements:'];
    value.elements.forEach(e => {
      const label = MOB_RESISTANCE_LABELS[e.index] ? ` (${MOB_RESISTANCE_LABELS[e.index]})` : '';
      lines.push(`  [${e.index}]${label} ${typeof e.value === 'object' ? JSON.stringify(e.value) : e.value} | raw=${e.raw}`);
    });
    return lines.join('\n');
  }
  return mobValueText(value);
}
// ScriptAttachmentPoint (game/script.h), generated into scr-schema.js.
const MOB_SCRIPT_POINTS = SCR_ATTACHMENT_POINTS.map(n => `SAP_${n}`);

function mobU32(view, o) { return view.getUint32(o, true); }
export function mobI32(view, o) { return view.getInt32(o, true); }
function mobI64(view, o) { return view.getBigInt64(o, true); }
// "0A FF ..": every field and array element gets one, so the 256 byte texts are made once.
const HEX_BYTES = Array.from({ length: 256 }, (_, b) => b.toString(16).padStart(2, '0').toUpperCase());
export function mobHex(bytes) { let s = ''; for (let i = 0; i < bytes.length; i++) s += i ? ` ${HEX_BYTES[bytes[i]]}` : HEX_BYTES[bytes[i]]; return s; }
export function mobOidText(bytes) {
  if (bytes.length !== 24) return mobHex(bytes);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // ObjectID: int16 type, 2 bytes padding, int32 padding, 16-byte union (obj_id.h).
  const type = dv.getInt16(0, true);
  const number = dv.getUint32(8, true);
  if (type === 1) return `A / number=${number} / raw=${mobHex(bytes)}`;
  if (type === 2) return `GUID / ${Array.from(bytes.slice(8,24), b => b.toString(16).padStart(2,'0')).join('')} / raw=${mobHex(bytes)}`;
  if (type === 3) return `P / location=${dv.getBigInt64(8, true)} / temp_id=${dv.getInt32(16, true)} / map=${dv.getInt32(20, true)} / raw=${mobHex(bytes)}`;
  if (type === -1) return `BLOCKED (prototype) / raw=${mobHex(bytes)}`;
  if (type === -2) return `HANDLE / h=${dv.getBigInt64(8, true)} / raw=${mobHex(bytes)}`;
  if (type === 0) return `NULL / raw=${mobHex(bytes)}`;
  return `type=${type} / raw=${mobHex(bytes)}`;
}
function mobGroupStart(fld) { let start=0; for(const x of MOB_GROUP_BEGIN){if(x<fld)start=x;else break;} return start; }
function mobGroupIndex(beginValue) { const i=MOB_GROUP_BEGIN.indexOf(beginValue); return i<0?0:i; }
function buildMobEngine() {
  const n=MOB_OD_TYPES.length, changeIdx=new Array(n).fill(-1), masks=new Array(n).fill(0), baseDword=new Array(MOB_GROUP_BEGIN.length).fill(0);
  for(let fld=0;fld<n;fld++){const od=MOB_OD_TYPES[fld]; if(od===1){const gi=mobGroupIndex(fld), parentLast=MOB_GROUP_PARENT_LAST[gi]; baseDword[gi]=parentLast<0?0:changeIdx[parentLast]+1; continue;} if(od===2)continue; const gs=mobGroupStart(fld), localIdx=fld-gs-1; changeIdx[fld]=Math.floor(localIdx/32)+baseDword[mobGroupIndex(gs)]; masks[fld]=(1<<(localIdx%32))>>>0;}
  const dwordCount=[]; for(let type=0;type<18;type++){const last=MOB_TYPE_LAST_FIELD[type]; dwordCount.push(last>=0?changeIdx[last]+1:0);} return {changeIdx,masks,dwordCount};
}
export const MOB_ENGINE=buildMobEngine();
export function enumerateMobFields(objType){const out=[];for(let f=1;f<37;f++)if(MOB_OD_TYPES[f]!==1&&MOB_OD_TYPES[f]!==2)out.push(f);const start=MOB_TYPE_RANGE_OFFSET[objType],end=MOB_TYPE_RANGE_OFFSET[objType+1];for(let r=start;r<end;r++)for(let f=MOB_TYPE_RANGE_BEGIN[r]+1;f<MOB_TYPE_RANGE_END[r];f++)if(MOB_OD_TYPES[f]!==1&&MOB_OD_TYPES[f]!==2)out.push(f);return out;}
export function mobBitIsSet(bitmap,fld){const ci=MOB_ENGINE.changeIdx[fld];return ci>=0&&ci<bitmap.length&&((bitmap[ci]>>>0)&MOB_ENGINE.masks[fld])!==0;}
function mobArrayElement(od,bytes,elemSize){const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);if((od===7||od===9)&&elemSize===4)return od===7?v.getInt32(0,true):v.getUint32(0,true);if((od===8||od===10)&&elemSize===8){const x=od===8?v.getBigInt64(0,true):v.getBigUint64(0,true);return x.toString();}if(od===11&&elemSize===12){const a=v.getUint32(0,true),b=v.getUint32(4,true),c=v.getUint32(8,true);return {script_record:`${a}, ${b}, ${c}`,script_num:c};}if(od===13&&elemSize===24)return mobOidText(bytes);return `0x${mobHex(bytes).replaceAll(' ','')}`;}
function readMobArray(view,bytes,offset,od){const start=offset,present=bytes[offset++];if(!present)return{value:'absent',size:1};if(offset+12>bytes.length)throw new Error('truncated array header');const elemSize=view.getInt32(offset,true),count=view.getInt32(offset+4,true),bitsetId=view.getInt32(offset+8,true);offset+=12;if(elemSize<0||count<0)throw new Error(`invalid array header size=${elemSize} count=${count}`);const dataBytes=elemSize*count;if(offset+dataBytes+4>bytes.length)throw new Error('truncated array payload');const payload=bytes.subarray(offset,offset+dataBytes);offset+=dataBytes;const bitsetCount=view.getInt32(offset,true);offset+=4;if(bitsetCount<0||offset+bitsetCount*4>bytes.length)throw new Error('invalid array bitset');const bits=[];for(let i=0;i<bitsetCount;i++)bits.push(view.getUint32(offset+i*4,true));offset+=bitsetCount*4;const logical=[];for(let wi=0;wi<bits.length;wi++){let w=bits[wi]>>>0;for(let bit=0;w;bit++,w>>>=1)if(w&1)logical.push(wi*32+bit);}const elements=[];for(let i=0;i<count;i++){const chunk=payload.subarray(i*elemSize,(i+1)*elemSize),logicalIndex=i<logical.length?logical[i]:`compact_${i}`,value=mobArrayElement(od,chunk,elemSize);if(od===11&&value&&typeof value==='object'){value.script_attachment=MOB_SCRIPT_POINTS[logicalIndex]||`SAP_${logicalIndex}`;value.script_attachment_index=logicalIndex;}elements.push({index:logicalIndex,value,raw:mobHex(chunk)});}return{value:{element_size:elemSize,count,bitset_id:bitsetId,bitset:bits,elements},size:offset-start};}
// One decoder for every string field (latin1, else the default one where latin1 is missing).
let textDecoder=null;
function stringDecoder(){
  if(!textDecoder){try{textDecoder=new TextDecoder('latin1');}catch(e){textDecoder=new TextDecoder();}}
  return textDecoder;
}
export function readMobField(view,bytes,offset,od){
  const start=offset;

  // INT32 is the one serialized object-field type without a presence byte.
  if(od===3){
    if(offset+4>bytes.length) throw new Error('truncated Int32');
    return {value:mobI32(view,offset),size:4};
  }

  if(offset>=bytes.length) throw new Error('truncated field presence byte');
  const present=bytes[offset++];

  if(od===4){
    if(!present) return {value:'absent',size:1};
    if(offset+8>bytes.length) throw new Error('truncated Int64');
    return {value:mobI64(view,offset).toString(),size:9};
  }

  if(od===5){
    if(!present) return {value:'absent',size:1};
    if(offset+4>bytes.length) throw new Error('truncated string length');
    const len=view.getInt32(offset,true);
    offset+=4;
    if(len<0 || offset+len+1>bytes.length) throw new Error('invalid string length');
    const raw=bytes.subarray(offset,offset+len);
    offset+=len;
    const trailing=bytes[offset++];
    const value=stringDecoder().decode(raw);
    return {value:{text:value,length:len,trailing_byte:trailing,raw:mobHex(raw)},size:offset-start};
  }

  if(od===6){
    if(!present) return {value:'absent',size:1};
    if(offset+24>bytes.length) throw new Error('truncated handle');
    return {value:mobOidText(bytes.subarray(offset,offset+24)),size:25};
  }

  if(od===14){
    return {value:present?'unsupported transient PTR':'absent',size:1};
  }

  if(od===7||od===8||od===9||od===10||od===11||od===12||od===13){
    return readMobArray(view,bytes,start,od);
  }

  throw new Error(`unsupported serialized OdType ${od}`);
}
export function decodeMobBuffer(buf,filename){const bytes=new Uint8Array(buf),view=new DataView(buf);if(bytes.length<62)throw new Error('file is too small to be a valid .mob');let offset=0;const version=mobU32(view,offset);offset+=4;const protoOid=bytes.slice(offset,offset+24);offset+=24;const objectOid=bytes.slice(offset,offset+24);offset+=24;const objType=view.getUint32(offset,true);offset+=4;const numFields=view.getUint16(offset,true);offset+=2;if(objType<0||objType>=MOB_TYPE_LAST_FIELD.length)throw new Error(`unsupported object type ${objType}`);const dwordCount=MOB_ENGINE.dwordCount[objType];if(offset+dwordCount*4>bytes.length)throw new Error('truncated FIELD_48 bitmap');const bitmap=[];for(let i=0;i<dwordCount;i++){bitmap.push(view.getUint32(offset,true));offset+=4;}const actualSet=bitmap.reduce((n,w)=>n+((w>>>0).toString(2).match(/1/g)||[]).length,0);const fields=[];for(const fld of enumerateMobFields(objType)){if(!mobBitIsSet(bitmap,fld))continue;const od=MOB_OD_TYPES[fld],fieldOffset=offset,parsed=readMobField(view,bytes,offset,od);offset+=parsed.size;fields.push({field:fld,name:MOB_FIELD_NAMES[fld]||`FIELD_${String(fld).padStart(3,'0')}`,od:MOB_OD_NAMES[od]||`OdType_${od}`,change_idx:MOB_ENGINE.changeIdx[fld],bit:MOB_ENGINE.masks[fld]?Math.round(Math.log2(MOB_ENGINE.masks[fld])):-1,offset:fieldOffset,size:parsed.size,raw:mobHex(bytes.subarray(fieldOffset,offset)),value:parsed.value});}return{filename,size:bytes.length,version,objType,numFields,actualSet,bitmap,protoOid,objectOid,fields,endOffset:offset,trailing:bytes.slice(offset)};}
export function mobLocationInfo(value){if(value===null||value===undefined||value==='absent')return null;let v;try{v=BigInt(value);}catch(e){return null;}const ux=BigInt.asUintN(32,v),uy=BigInt.asUintN(32,v>>32n),worldX=Number(ux),worldY=Number(uy);return{worldX,worldY,sectorX:worldX>>6,sectorY:worldY>>6,tileX:worldX&63,tileY:worldY&63};}
export function mobValueText(value,indent=''){if(value===null||value===undefined)return'NULL / absent';if(typeof value==='object'){if(Array.isArray(value))return value.map((v,i)=>`${indent}[${i}] ${mobValueText(v,indent+'  ')}`).join('\n');if(value.elements)return[`element_size=${value.element_size}`,`count=${value.count}`,`bitset_id=${value.bitset_id}`,`bitset=${value.bitset.join(' ')}`,'elements:',...value.elements.map(e=>`  [${e.index}] ${typeof e.value==='object'?JSON.stringify(e.value):e.value} | raw=${e.raw}`)].join('\n');return Object.entries(value).map(([k,v])=>`${k}=${typeof v==='object'?JSON.stringify(v):v}`).join('\n');}return String(value);}

// F_CURRENT_AID is a packed 32-bit value: 09 00 XX YY (little-endian
// numeric form 0xYYXX0009). The YY byte selects the Art-ID block and XX
// advances by 2 for each Art ID. For example:
//   09 00 30 61 -> 9152
//   09 00 3A 61 -> 9157
//   09 00 8E 60 -> 9071
// Keep the raw packed number in parentheses so the original field value
// remains visible.
export function mobCurrentAidText(value, objectType){
  if (value === null || value === undefined) return mobValueText(value);
  const artId = protoCurrentAidArtId(value, objectType);
  if (artId === null) {
    const critter = protoCritterAidInfo(value, objectType);
    return critter ? critter.text : mobValueText(value);
  }
  const raw = Number(value) >>> 0;
  return `${artId} (${raw})`;
}
