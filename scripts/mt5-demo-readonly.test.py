import unittest, importlib.util, os
from pathlib import Path
from types import SimpleNamespace as N
spec=importlib.util.spec_from_file_location('demo',Path(__file__).with_name('mt5-demo-readonly.py'))
demo=importlib.util.module_from_spec(spec);spec.loader.exec_module(demo)
class Broker:
    SYMBOL_TRADE_MODE_FULL=4
    def __init__(self):self.mode=0;self.login=123;self.server='demo-server';self.calls=[];self.closed=False
    def initialize(self,*args,**kw):self.calls.append((args,kw));return True
    def account_info(self):return N(login=self.login,server=self.server,trade_mode=self.mode)
    def terminal_info(self):return N(connected=True,path=os.path.dirname(os.path.abspath('demo-terminal')),data_path=os.path.dirname(os.path.abspath('demo-terminal')))
    def symbols_get(self):self.calls.append('symbols');return []
    def shutdown(self):self.closed=True
    def order_send(self,*args):raise AssertionError('Must never reach broker')
class Tests(unittest.TestCase):
    def guard(self,b):return demo.DemoOnly(b,'demo-terminal',123,'demo-server')
    def test_connects_portable_demo_without_login_or_trade(self):
        b=Broker();g=self.guard(b);self.assertTrue(g.initialize('demo-terminal',timeout=10000));self.assertTrue(b.calls[0][1]['portable']);self.assertEqual(g.account_info().trade_mode,0);self.assertEqual(g.symbols_get(),[])
    def test_rejects_real_contest_missing_mode_wrong_login_or_server(self):
        for change in [lambda b:setattr(b,'mode',2),lambda b:setattr(b,'mode',1),lambda b:setattr(b,'mode',None),lambda b:setattr(b,'login',456),lambda b:setattr(b,'server','other')]:
            b=Broker();change(b)
            with self.assertRaises(RuntimeError):self.guard(b).initialize('demo-terminal')
            self.assertTrue(b.closed)
    def test_no_terminal_fallback_and_no_trade_api(self):
        b=Broker();g=self.guard(b)
        with self.assertRaises(RuntimeError):g.initialize('real-terminal')
        self.assertEqual(b.calls,[])
        for name in ['order_send','order_check','login','market_book_add','unknown']:
            with self.assertRaises(RuntimeError):getattr(g,name)
    def test_mid_read_account_switch_blocks_next_read(self):
        b=Broker();g=self.guard(b);g.initialize('demo-terminal');b.mode=2
        with self.assertRaises(RuntimeError):g.symbols_get()
        self.assertNotIn('symbols',b.calls)
    def test_same_demo_identity_from_another_terminal_is_rejected(self):
        b=Broker();b.terminal_info=lambda:N(connected=True,path='wrong-installation',data_path='wrong-installation')
        with self.assertRaises(RuntimeError):self.guard(b).initialize('demo-terminal')
    def test_readonly_instrument_constant_is_available_without_order_api(self):
        self.assertEqual(self.guard(Broker()).SYMBOL_TRADE_MODE_FULL,4)
    def test_trading_collector_reads_nonempty_demo_universe_without_trade_api(self):
        from unittest.mock import patch
        source=importlib.util.spec_from_file_location('collector',Path(__file__).with_name('mt5-trading-adapter.py'))
        collector=importlib.util.module_from_spec(source);source.loader.exec_module(collector)
        class Full(Broker):
            def account_info(self):return N(login=123,server='demo-server',trade_mode=0,currency='EUR',equity=50000,balance=50000,profit=0,credit=0,margin_free=50000,company='demo')
            def symbols_get(self):return [N(name='TEST',visible=True,trade_mode=4,point=.0001,volume_min=.01,volume_max=100,volume_step=.01,trade_stops_level=0)]
            def symbol_info_tick(self,name):return None
            def positions_get(self):return []
            def orders_get(self):return []
        with patch.object(collector._clock_module,'sample_clock',return_value=[]):
            result=collector.collect_market(self.guard(Full()),'demo-terminal',123,'demo-server')
        self.assertEqual(result['account']['mode'],0);self.assertEqual(len(result['instruments']),1);self.assertFalse(result['executionEnabled'])
if __name__=='__main__':unittest.main()
