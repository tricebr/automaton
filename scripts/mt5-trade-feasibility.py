"""Read-only FX execution feasibility. Never submits or prepares a terminal order.

Cost/margin estimates are not signals, profitability evidence or guaranteed fills.
"""
import argparse
import json
import math
import time
from datetime import datetime, timezone
from pathlib import Path


def finite_positive(value):
    return isinstance(value, (int, float)) and math.isfinite(value) and value > 0


def inspect(mt5, terminal, login, server, server_offset_seconds=0):
    if server_offset_seconds not in (0, 7200, 10800):
        raise ValueError('Unsupported explicit server clock offset')
    if not mt5.initialize(terminal, timeout=10000):
        raise RuntimeError('Terminal unavailable')
    try:
        account = mt5.account_info()
        terminal_info = mt5.terminal_info()
        if (account is None or terminal_info is None or not terminal_info.connected
                or account.login != login or account.server != server):
            raise RuntimeError('Account identity or connection mismatch')
        positions, orders, symbols = mt5.positions_get(), mt5.orders_get(), mt5.symbols_get()
        if positions is None or orders is None or symbols is None:
            raise RuntimeError('Incomplete observation')
        rows = []
        # Both currencies must be fiat; metals, crypto, indices excluded explicitly.
        fiat = set('USD EUR GBP JPY CHF CAD AUD NZD NOK SEK DKK PLN CZK HUF SGD HKD CNH CNY ZAR TRY MXN'.split())
        for symbol in symbols:
            if (symbol.currency_base not in fiat or symbol.currency_profit not in fiat
                    or symbol.currency_base == symbol.currency_profit
                    or not symbol.name.startswith(symbol.currency_base + symbol.currency_profit)):
                continue
            row = {'symbol': symbol.name, 'visible': symbol.visible,
                   'minimumLots': symbol.volume_min, 'lotStep': symbol.volume_step,
                   'tradeMode': symbol.trade_mode, 'status': 'not_observed'}
            rows.append(row)
            # Do not change Market Watch settings to obtain prices.
            if not symbol.visible:
                row['status'] = 'not_visible'
                continue
            tick = mt5.symbol_info_tick(symbol.name)
            if tick is None or not finite_positive(tick.bid) or not finite_positive(tick.ask) or tick.ask < tick.bid:
                row['status'] = 'invalid_quote'
                continue
            raw_age = time.time() - tick.time_msc / 1000
            age = raw_age + server_offset_seconds
            row.update(bid=tick.bid, ask=tick.ask, quoteAgeSeconds=round(age, 3),
                       rawTickTimeMsc=tick.time_msc, rawQuoteAgeSeconds=round(raw_age, 3))
            if age < -2:
                row['status'] = 'future_timestamp'
                continue
            if age > 15:
                row['status'] = 'stale_quote'
                continue
            if symbol.trade_mode != mt5.SYMBOL_TRADE_MODE_FULL or not finite_positive(symbol.volume_min):
                row['status'] = 'restricted'
                continue
            spread = mt5.order_calc_profit(mt5.ORDER_TYPE_BUY, symbol.name, symbol.volume_min, tick.ask, tick.bid)
            buy_margin = mt5.order_calc_margin(mt5.ORDER_TYPE_BUY, symbol.name, symbol.volume_min, tick.ask)
            sell_margin = mt5.order_calc_margin(mt5.ORDER_TYPE_SELL, symbol.name, symbol.volume_min, tick.bid)
            values = (spread, buy_margin, sell_margin)
            if any(v is None or not math.isfinite(v) for v in values) or spread > 0 or min(buy_margin, sell_margin) < 0:
                row['status'] = 'calculation_unavailable'
                continue
            row.update(status='observed', spreadCostAtMinimumLots=-spread,
                       buyMarginAtMinimumLots=buy_margin, sellMarginAtMinimumLots=sell_margin)
        final = mt5.account_info()
        if final is None or final.login != login or final.server != server:
            raise RuntimeError('Account changed during observation')
        return {'observedAt': datetime.now(timezone.utc).isoformat(), 'readOnly': True,
                'executionEnabled': False, 'decision': 'NO_TRADE',
                'reason': 'No independently validated strategy with a current entry/exit signal supplied',
                'serverOffsetSeconds': server_offset_seconds,
                'clockPolicy': 'Explicit diagnostic offset for this invocation only; not automatically inferred or persisted',
                'currency': account.currency, 'equity': account.equity, 'freeMargin': account.margin_free,
                'positionCount': len(positions), 'pendingOrderCount': len(orders), 'instruments': rows,
                'limitations': ['Non-atomic observation; quotes expire after 15 seconds',
                    'Spread estimate excludes commissions, slippage and financing',
                    'Margin calculations do not incorporate existing positions or orders',
                    'No ranking by expected profitability; no order ticket generated',
                    'Only listed fiat FX crosses considered; invisible symbols not subscribed']}
    finally:
        mt5.shutdown()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--terminal', required=True)
    parser.add_argument('--login', type=int, required=True)
    parser.add_argument('--server', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--server-offset-seconds', type=int, choices=[0, 7200, 10800], default=0)
    args = parser.parse_args()
    import MetaTrader5 as mt5
    result = inspect(mt5, args.terminal, args.login, args.server, args.server_offset_seconds)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2, allow_nan=False), encoding='utf-8')
    print(json.dumps({k: v for k, v in result.items() if k != 'instruments'}, allow_nan=False))
    print(json.dumps({'instruments': len(result['instruments']), 'visible': [r for r in result['instruments'] if r['visible']]}))
