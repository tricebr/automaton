"""Demo-bound read-only facade. No login, order check or order submission API."""
import argparse, importlib.util, json, os
from pathlib import Path

class DemoOnly:
    READS=frozenset(['symbols_get','symbol_info','symbol_info_tick','copy_rates_from_pos',
        'copy_ticks_from','history_deals_get','history_deals_total','positions_get',
        'orders_get','order_calc_margin','order_calc_profit','symbol_select'])
    CONSTANTS=frozenset(['TIMEFRAME_M5','ORDER_TYPE_BUY','ORDER_TYPE_SELL','COPY_TICKS_ALL',
        'DEAL_TYPE_BALANCE','DEAL_TYPE_BUY','DEAL_TYPE_SELL','SYMBOL_TRADE_MODE_FULL'])
    def __init__(self,broker,terminal,login,server):
        self._broker=broker;self._terminal=terminal;self._login=login;self._server=server;self._ready=False
    def _check(self):
        a=self._broker.account_info();t=self._broker.terminal_info()
        expected=os.path.normcase(os.path.dirname(os.path.abspath(self._terminal)))
        same_terminal=t is not None and all(isinstance(getattr(t,k,None),str) and os.path.normcase(os.path.abspath(getattr(t,k)))==expected for k in ['path','data_path'])
        if a is None or t is None or not t.connected or not same_terminal or a.login!=self._login or a.server!=self._server or getattr(a,'trade_mode',None)!=0:
            self._ready=False
            raise RuntimeError('Required bound demo account unavailable; no real-account fallback')
        return a
    def initialize(self,terminal,timeout=10000):
        if os.path.normcase(os.path.abspath(terminal))!=os.path.normcase(os.path.abspath(self._terminal)):
            raise RuntimeError('Wrong demo terminal path')
        if not self._broker.initialize(self._terminal,timeout=timeout,portable=True):return False
        try:self._check();self._ready=True;return True
        except Exception:self._broker.shutdown();raise
    def account_info(self):
        if not self._ready:raise RuntimeError('Demo connection not initialized')
        return self._check()
    def terminal_info(self):
        self.account_info();return self._broker.terminal_info()
    def shutdown(self):
        self._ready=False;self._broker.shutdown()
    def __getattr__(self,name):
        if name in self.CONSTANTS:return getattr(self._broker,name)
        if name not in self.READS:raise RuntimeError('MT5 capability not allowed in demo reader')
        def read(*args,**kwargs):
            self.account_info();result=getattr(self._broker,name)(*args,**kwargs);self.account_info();return result
        return read

def main():
    p=argparse.ArgumentParser()
    p.add_argument('--reader',choices=['account','market','trading','history'],default='account')
    p.add_argument('--terminal',required=True);p.add_argument('--login','--expected-login',dest='login',type=int,required=True)
    p.add_argument('--server',required=True);p.add_argument('--output');p.add_argument('--start',type=int,default=0)
    p.add_argument('--watch',action='append',default=[]);p.add_argument('--symbols',default='EURUSD,GBPUSD,USDJPY')
    p.add_argument('--day-start',type=int);p.add_argument('--day-end',type=int)
    args=p.parse_args()
    import MetaTrader5 as mt5
    broker=DemoOnly(mt5,args.terminal,args.login,args.server)
    names={'account':'mt5-readonly.py','market':'mt5-market-readonly.py','trading':'mt5-trading-adapter.py','history':'mt5-strategy-evidence.py'}
    spec=importlib.util.spec_from_file_location('numaron_demo_reader',Path(__file__).with_name(names[args.reader]))
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    if args.reader=='account':result=module.snapshot(broker,args.terminal,args.login)
    elif args.reader=='market':result=module.read_market(broker,args.terminal,args.login,args.server,args.start)
    elif args.reader=='history':result=module.read(broker,args.terminal,args.login,args.server,args.symbols.split(','))
    else:result=module.collect_market(broker,args.terminal,args.login,args.server,args.start,args.watch,{'startsAt':args.day_start,'endsAt':args.day_end} if args.day_start is not None and args.day_end is not None else None)
    result['accountBinding']={'demo':True,'tradeMode':0,'portable':True,'executionEnabled':False}
    encoded=json.dumps(result,allow_nan=False)
    if args.output:
        output=Path(args.output);temporary=output.with_suffix('.tmp');temporary.write_text(encoded,encoding='utf-8');temporary.replace(output)
        print(json.dumps({'readOnly':True,'demo':True,'executionEnabled':False}))
    else:print(encoded)
if __name__=='__main__':main()
