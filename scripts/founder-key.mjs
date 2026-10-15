import fs from 'node:fs';
export function readFounderKey(file){
 try{if(typeof file!=='string')throw Error();const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384)throw Error();const b=fs.readFileSync(file),text=b[0]===255&&b[1]===254?b.subarray(2).toString('utf16le'):b.toString('utf8');const keys=[...new Set(text.match(/sk-[A-Za-z0-9_-]{20,}/g)??[])];if(keys.length!==1)throw Error();return keys[0];}catch{throw Error('Founder credential unavailable');}
}
