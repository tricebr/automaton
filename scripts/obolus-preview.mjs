import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
const assets=new Map([
 ['/',{body:readFileSync(new URL('../web/obolus-public/index.html',import.meta.url)),type:'text/html; charset=utf-8'}],
 ['/styles.css',{body:readFileSync(new URL('../web/obolus-public/styles.css',import.meta.url)),type:'text/css; charset=utf-8'}],
]);
const port=57821;
const policy=readFileSync(new URL('../web/obolus-public/_headers',import.meta.url),'utf8')
 .match(/Content-Security-Policy: ([^\r\n]+)/)?.[1];
if(!policy)throw Error('Static preview Content-Security-Policy missing');
createServer((req,res)=>{
 res.setHeader('X-Content-Type-Options','nosniff');
 res.setHeader('Cache-Control','no-store');
 res.setHeader('Content-Security-Policy',policy);
 if(req.headers.host!==`127.0.0.1:${port}`||!['GET','HEAD'].includes(req.method)){res.writeHead(403);res.end();return;}
 const asset=assets.get(req.url);
 if(!asset){res.writeHead(404);res.end();return;}
 res.setHeader('Content-Type',asset.type);res.writeHead(200);res.end(req.method==='HEAD'?undefined:asset.body);
}).listen(port,'127.0.0.1',()=>console.log(`Obolus static preview: http://127.0.0.1:${port}/ (no agent started)`));
