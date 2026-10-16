import {it,expect,vi,afterEach} from 'vitest';
import {gzipSync} from 'node:zlib';
import https from 'node:https';import dns from 'node:dns';import {EventEmitter} from 'node:events';
import {fixedPublicFetch,publicIPv4Address} from '../online/fixed-public-fetch.js';
const options={method:'GET',redirect:'error',credentials:'omit',signal:new AbortController().signal,headers:{Accept:'application/json'}} as const;
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
it.each(['127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','198.18.0.1','224.0.0.1','0.0.0.0','::1','::ffff:127.0.0.1','2001:db8::1','192.0.2.1','198.51.100.1','203.0.113.1'])('denies reserved/private address %s',address=>expect(publicIPv4Address(address)).toBe(false));
it('accepts a public IPv4 address without resolving it',()=>expect(publicIPv4Address('8.8.8.8')).toBe(true));
function transport(addresses:{address:string;family:number}[],status=200,body=Buffer.from('{}'),encoding?:string,extraHeaders:Record<string,string>={}){
 const request=new EventEmitter() as EventEmitter&{destroy:ReturnType<typeof vi.fn>;end:()=>void};request.destroy=vi.fn();
 const response=new EventEmitter() as EventEmitter&{statusCode:number;headers:object;destroy:ReturnType<typeof vi.fn>};response.statusCode=status;response.headers={...(encoding?{'content-encoding':encoding}:{}),...extraHeaders};response.destroy=vi.fn();
 vi.spyOn(dns,'lookup').mockImplementation(((_host:unknown,_opts:unknown,callback:Function)=>{callback(null,addresses);}) as never);
 vi.spyOn(https,'request').mockImplementation(((_url:unknown,opts:any,callback:Function)=>{
  expect(opts).toMatchObject({agent:false,family:4,rejectUnauthorized:true});
  request.end=()=>opts.lookup('api.github.com',{},(error:Error|null,address:string)=>{if(error)request.emit('error',error);else{expect(address).toBe(addresses[0].address);callback(response);if(status===200){response.emit('data',body);response.emit('end');}}});return request;
 }) as never);return request;
}
it('pins validated DNS result to TLS connection and returns bounded response',async()=>{transport([{address:'8.8.8.8',family:4}]);expect(await (await fixedPublicFetch('https://api.github.com/search/issues',options)).json()).toEqual({});expect(dns.lookup).toHaveBeenCalledTimes(1);});
it('mixed DNS answers fail closed, without selecting the public answer',async()=>{transport([{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]);await expect(fixedPublicFetch('https://api.github.com/search/issues',options)).rejects.toThrow('rejected');});
it('never follows a redirect',async()=>{const request=transport([{address:'8.8.8.8',family:4}],302);await expect(fixedPublicFetch('https://api.github.com/search/issues',options)).rejects.toThrow();expect(request.destroy).toHaveBeenCalled();expect(https.request).toHaveBeenCalledTimes(1);});
it.each([401,403,404,429,503])('exposes only HTTP failure status %s so the caller can distinguish missing files and access review',async status=>{
 const request=transport([{address:'8.8.8.8',family:4}],status,Buffer.from('private error body'),undefined,{'set-cookie':'secret','location':'https://example.invalid'});
 const response=await fixedPublicFetch('https://api.github.com/repos/Specula-Labs/specula-api/readme',options);
 expect(response.status).toBe(status);expect(await response.text()).toBe('');expect(response.headers.get('set-cookie')).toBeNull();expect(response.headers.get('location')).toBeNull();expect(request.destroy).toHaveBeenCalled();
});
it('cannot accept credentials or arbitrary headers',async()=>{const spy=vi.spyOn(https,'request');await expect(fixedPublicFetch('https://api.github.com/search/issues',{...options,headers:{Authorization:'synthetic'}})).rejects.toThrow('contract');expect(spy).not.toHaveBeenCalled();});
it('synchronous transport failure clears its deadline',async()=>{vi.useFakeTimers();vi.spyOn(https,'request').mockImplementation(()=>{throw Error('fixture');});await expect(fixedPublicFetch('https://api.github.com/search/issues',options)).rejects.toThrow();expect(vi.getTimerCount()).toBe(0);});

it('supports compressed JSON without increasing the decompressed limit',async()=>{
 transport([{address:'8.8.8.8',family:4}],200,gzipSync(Buffer.from('{"items":[]}')),'gzip');
 expect(await (await fixedPublicFetch('https://api.github.com/search/issues',options)).json()).toEqual({items:[]});
});
it('rejects a compressed expansion beyond one megabyte',async()=>{
 transport([{address:'8.8.8.8',family:4}],200,gzipSync(Buffer.alloc(1000001,65)),'gzip');
 await expect(fixedPublicFetch('https://api.github.com/search/issues',options)).rejects.toThrow('rejected');
});
it.each([200,302,429,503])('preserves Retry-After at status %s without reading content or following redirects',async status=>{
 const request=transport([{address:'8.8.8.8',family:4}],status,Buffer.from('must not be returned'),undefined,{'retry-after':'604800','set-cookie':'private-fixture','location':'https://example.invalid'});
 const response=await fixedPublicFetch('https://api.github.com/search/issues',options);
 expect(response.headers.get('retry-after')).toBe('604800');expect(response.headers.get('set-cookie')).toBeNull();expect(response.headers.get('location')).toBeNull();expect(await response.text()).toBe('');
 expect(request.destroy).toHaveBeenCalled();expect(https.request).toHaveBeenCalledTimes(1);
});
