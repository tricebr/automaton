import {inflateRawSync} from 'node:zlib';
import {HISTORY_LIMITS} from './types.js';
const crcTable=Array.from({length:256},(_,i)=>{let c=i;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
const crc32=(b:Uint8Array)=>{let c=0xffffffff;for(const byte of b)c=crcTable[(c^byte)&255]^(c>>>8);return (c^0xffffffff)>>>0;};
function extractZip(bytes:Uint8Array,limits:{maxBytes:number},allowed:(name:string)=>boolean,target:string|null,maxEntries:number):Uint8Array{
 if(!Number.isSafeInteger(limits.maxBytes)||limits.maxBytes<=0||bytes.length>HISTORY_LIMITS.fileBytes||bytes.length<22)throw Error('Invalid archive size');
 const b=Buffer.from(bytes),max=Math.min(limits.maxBytes,HISTORY_LIMITS.fileBytes);let end=-1;
 for(let p=b.length-22;p>=Math.max(0,b.length-65557);p--)if(b.readUInt32LE(p)===0x06054b50&&p+22+b.readUInt16LE(p+20)===b.length){end=p;break;}
 if(end<0||b.readUInt16LE(end+4)||b.readUInt16LE(end+6))throw Error('Unsupported archive entries');
 const count=b.readUInt16LE(end+10);if(count<1||count>maxEntries||b.readUInt16LE(end+8)!==count)throw Error('Unsupported archive entries');
 const pos=b.readUInt32LE(end+16),centralSize=b.readUInt32LE(end+12);
 if(pos+centralSize!==end||centralSize<46||pos+46>end||b.readUInt32LE(pos)!==0x02014b50)throw Error('Invalid archive directory');
 let p=pos,total=0,output:Uint8Array|null=null;const names=new Set<string>(),ranges:{start:number;end:number}[]=[];
 for(let i=0;i<count;i++){
  if(p+46>end||b.readUInt32LE(p)!==0x02014b50)throw Error('Invalid archive directory');
  const flags=b.readUInt16LE(p+8),method=b.readUInt16LE(p+10),crc=b.readUInt32LE(p+16),packed=b.readUInt32LE(p+20),size=b.readUInt32LE(p+24),nameLength=b.readUInt16LE(p+28),extra=b.readUInt16LE(p+30),comment=b.readUInt16LE(p+32),offset=b.readUInt32LE(p+42),next=p+46+nameLength+extra+comment;
  if(flags&~(8|2048)||![0,8].includes(method)||b.readUInt16LE(p+34)||next>end)throw Error('Unsupported archive encoding');
  total+=size;if(!size||total>max||!packed||size>packed*100)throw Error('Archive expansion size limit');
  const name=b.subarray(p+46,p+46+nameLength).toString('utf8');if(!allowed(name)||names.has(name)||name.includes('..')||/[\\/]/.test(name))throw Error('Unsafe archive path');names.add(name);
  if(offset+30>pos||b.readUInt32LE(offset)!==0x04034b50||b.readUInt16LE(offset+6)!==flags||b.readUInt16LE(offset+8)!==method)throw Error('Invalid archive header');
  const localNameLength=b.readUInt16LE(offset+26),localExtra=b.readUInt16LE(offset+28),start=offset+30+localNameLength+localExtra;
  if(start+packed>pos||b.subarray(offset+30,offset+30+localNameLength).toString('utf8')!==name||ranges.some(r=>offset<r.end&&start+packed>r.start))throw Error('Invalid archive bounds');ranges.push({start:offset,end:start+packed});
  if(!(flags&8)&&(b.readUInt32LE(offset+14)!==crc||b.readUInt32LE(offset+18)!==packed||b.readUInt32LE(offset+22)!==size))throw Error('Invalid archive sizes');
  if(target===null||target===name){const data=b.subarray(start,start+packed),value=method===0?data:inflateRawSync(data,{maxOutputLength:max});if(value.length!==size||crc32(value)!==crc)throw Error('Archive CRC mismatch');output=value;}
  p=next;
 }
 if(p!==end||!output)throw Error('Missing archive data');return output;
}
export function extractSingleCsvZip(bytes:Uint8Array,limits:{maxBytes:number}){return extractZip(bytes,limits,name=>/^[a-zA-Z0-9_.-]+\.csv$/i.test(name),null,1);}
export function extractBoardXmlZip(bytes:Uint8Array,limits:{maxBytes:number}){return extractZip(bytes,limits,name=>['H15_data.xml','H15_struct.xml','H15_discontinued.xsd','H15_H15.xsd','frb_common.xsd'].includes(name),'H15_data.xml',5);}
