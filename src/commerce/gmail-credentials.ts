/** Credentials are operator-injected. No token is logged, persisted or exposed as an agent tool. */
export function createGmailTokenProvider(environment:Record<string,string|undefined>=process.env,request:typeof fetch=fetch){
  let cached:string|undefined,expiresAt=0,pending:Promise<string>|undefined,retryAt=0;
  const valid=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=16384&&!/\s/.test(value);
  // Snapshot configuration for one provider lifecycle. Recreate it after credential rotation.
  const access=environment.OBOLUS_GMAIL_ACCESS_TOKEN;
  const clientId=environment.OBOLUS_GMAIL_CLIENT_ID,clientSecret=environment.OBOLUS_GMAIL_CLIENT_SECRET,refresh=environment.OBOLUS_GMAIL_REFRESH_TOKEN;
  const refreshing=[clientId,clientSecret,refresh].some(value=>value!==undefined);
  return async()=>{
    if(!refreshing){if(!valid(access))throw new Error('Gmail credentials unavailable');return access;}
    if(![clientId,clientSecret,refresh].every(valid))throw new Error('Complete Gmail refresh configuration required');
    if(cached&&Date.now()<expiresAt)return cached;
    if(pending)return pending;
    if(Date.now()<retryAt)throw new Error('Gmail token refresh temporarily blocked');
    pending=(async()=>{
      try{
        const started=Date.now();
        const response=await request('https://oauth2.googleapis.com/token',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),
          headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:clientId!,client_secret:clientSecret!,refresh_token:refresh!}).toString()});
        if(!response.ok||!response.body)throw new Error('refresh rejected');
        const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
        try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>32768)throw new Error('oversized token response');chunks.push(part.value);}}finally{await reader.cancel();}
        const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if(!valid(body.access_token)||typeof body.token_type!=='string'||body.token_type.toLowerCase()!=='bearer'||
          !Number.isSafeInteger(body.expires_in)||body.expires_in<=60||body.expires_in>86400)throw new Error('invalid token response');
        expiresAt=started+(body.expires_in-60)*1000;
        if(Date.now()>=expiresAt)throw new Error('token expired during refresh');
        cached=body.access_token;retryAt=0;return cached!;
      }catch{cached=undefined;expiresAt=0;retryAt=Date.now()+60000;throw new Error('Gmail token refresh failed; operator credentials may need renewal');}
    })();
    try{return await pending;}finally{pending=undefined;}
  };
}
