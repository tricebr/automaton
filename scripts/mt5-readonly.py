"""One-shot local MT5 telemetry. No login, orders, settings or trade calls."""
import argparse
import json
from datetime import datetime, timezone
from pathlib import Path


def snapshot(mt5, terminal, expected_login):
    if not mt5.initialize(terminal, timeout=10000):
        raise RuntimeError('MT5 initialization failed')
    try:
        info = mt5.terminal_info()
        account = mt5.account_info()
        if info is None or not info.connected or account is None:
            raise RuntimeError('Terminal not connected to an account')
        if account.login != expected_login:
            raise RuntimeError('Unexpected account; refusing telemetry')
        positions = mt5.positions_get()
        orders = mt5.orders_get()
        if positions is None or orders is None:
            raise RuntimeError('Incomplete positions or pending orders snapshot')
        final_account = mt5.account_info()
        if (final_account is None or final_account.login != account.login
                or final_account.server != account.server):
            raise RuntimeError('Account changed during observation')
        select = lambda value, keys: {k: getattr(value, k) for k in keys}
        return {
            'schemaVersion': 1,
            'observedAt': datetime.now(timezone.utc).isoformat(),
            'readOnly': True, 'executionEnabled': False,
            'account': select(account, ['login', 'server', 'currency', 'balance',
                'equity', 'profit', 'margin', 'margin_free', 'leverage', 'trade_mode']),
            'positions': [select(p, ['ticket', 'symbol', 'type', 'volume',
                'price_open', 'price_current', 'sl', 'tp', 'profit', 'swap']) for p in positions],
            'pendingOrders': [select(o, ['ticket', 'symbol', 'type',
                'volume_current', 'price_open', 'sl', 'tp']) for o in orders],
            'limitations': ['Non-atomic snapshot; refresh before decisions',
                'Existing positions are operator positions, not Obolus trades'],
        }
    finally:
        mt5.shutdown()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--terminal', required=True)
    parser.add_argument('--expected-login', required=True, type=int)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    import MetaTrader5 as mt5
    result = snapshot(mt5, args.terminal, args.expected_login)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix('.tmp')
    temporary.write_text(json.dumps(result, indent=2), encoding='utf-8')
    temporary.replace(output)
    print(json.dumps({'readOnly': True, 'currency': result['account']['currency'],
        'balance': result['account']['balance'], 'equity': result['account']['equity'],
        'freeMargin': result['account']['margin_free'],
        'positions': len(result['positions']), 'pendingOrders': len(result['pendingOrders'])}))
