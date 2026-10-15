export function nativeRows(content){const rows=JSON.parse(content);if(!Array.isArray(rows)||!rows.length||rows.length>200||rows.some(r=>!Array.isArray(r)||r.length>20||r.some(v=>typeof v!=='string'||v.length>2000)))throw Error('Invalid spreadsheet values');return rows;}
export async function writeNativeOutput({format,id,content,headers,call,ctx}){
 if(!/^[-\w]{1,200}$/.test(id))throw Error('Invalid native file ID');
 if(format==='document'){
  const url=`https://docs.googleapis.com/v1/documents/${id}`;
  const text=d=>(d.body?.content??[]).flatMap(x=>x.paragraph?.elements??[]).map(x=>x.textRun?.content??'').join('');
  let doc=await call(url,{method:'GET',headers},ctx);if(doc.documentId!==id)throw Error('Document identity mismatch');
  if(text(doc)!==content+'\n'){
   if(text(doc).trim()||!doc.revisionId)throw Error('Document changed; reconcile before writing');
   await call(url+':batchUpdate',{method:'POST',headers,body:JSON.stringify({writeControl:{requiredRevisionId:doc.revisionId},requests:[{insertText:{location:{index:1},text:content}}]})},ctx);
   doc=await call(url,{method:'GET',headers},ctx);
  }
  if(doc.documentId!==id||text(doc)!==content+'\n')throw Error('Document content verification failed');return;
 }
 if(format==='spreadsheet'){
  const rows=nativeRows(content),base=`https://sheets.googleapis.com/v4/spreadsheets/${id}`,url=base+'/values/Numaron!A1:T200';
  const meta=await call(base+'?fields=sheets(properties(sheetId,title))',{method:'GET',headers},ctx);
  if(!Array.isArray(meta.sheets))throw Error('Spreadsheet metadata unavailable');
  if(!meta.sheets.some(s=>s.properties?.title==='Numaron')){
   // Both requests are atomic. A concurrent tab creation rejects the whole batch.
   await call(base+':batchUpdate',{method:'POST',headers,body:JSON.stringify({requests:[{addSheet:{properties:{sheetId:173801,title:'Numaron'}}},{updateCells:{start:{sheetId:173801,rowIndex:0,columnIndex:0},rows:rows.map(row=>({values:row.map(value=>({userEnteredValue:{stringValue:value}}))})),fields:'userEnteredValue'}}]})},ctx);
  }
  const data=await call(url,{method:'GET',headers},ctx);
  // Sheets omits trailing empty cells/rows when reading values.
  const normalize=v=>{const r=v.map(row=>{const c=[...row];while(c.length&&c.at(-1)==='')c.pop();return c;});while(r.length&&!r.at(-1).length)r.pop();return r;};
  if(JSON.stringify(normalize(data.values??[]))!==JSON.stringify(normalize(rows)))throw Error('Spreadsheet changed; existing content preserved');return;
 }
 throw Error('Unsupported native format');
}
