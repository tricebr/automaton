import{parentPort,workerData}from'node:worker_threads';
try{
 const {operation,options}=workerData;let value;
 if(operation==='service'){const{readServiceAccess}=await import('./founder-service-access.mjs');value=readServiceAccess(options.provider,{directory:options.directory});}
 else if(['google-access','google-client','google-save'].includes(operation)){const{googleLocalCredentialOperation}=await import('./founder-google-access.mjs');value=googleLocalCredentialOperation(operation,options.value);}
 else throw Error('Unsupported operation');
 parentPort.postMessage({ok:true,value});
}catch{parentPort.postMessage({ok:false});}
