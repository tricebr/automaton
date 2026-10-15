# Numaron operating instructions

## Manual power control

Numaron must remain OFF until Patrice deliberately uses the dashboard's "Numaron einschalten" button and confirms the start personally. This is a human operating control, not a test fixture.

- Never click or confirm the production start button through browser automation.
- Never send a production start/resume request, invoke production power/controller start functions, or edit the persisted power/controller state to ON.
- A request to continue development, fix code, collect research data, run tests, deploy, or restart the local dashboard does not authorize turning Numaron ON. Older work instructions never override a newer OFF instruction.
- Test ON transitions only with temporary isolated files/databases and fake adapters; never use production accounts, API keys, or the production dashboard to test starting.
- Restarting the local UI must leave Numaron OFF. Preserve existing OFF states and check them after maintenance.
- A confirmed running ON session must not be interrupted merely to activate repairs or UI changes. Do not click OFF, send stop requests, kill the service/supervisor, or restart it for maintenance without Patrice's explicit authorization to interrupt that session. Finish offline checks and leave changes pending instead. The maintenance launcher must refuse restart while ON or when power state is unreadable; never bypass this guard by first switching OFF.
- Reading status and turning Numaron OFF when requested are allowed. Do not silently restart research, market collection, background provider reads, or AI work while OFF.
- If real collection requires ON, finish the implementation and offline checks, leave the system OFF, and tell Patrice to use the manual button when ready.

Do not discard unrelated work or disclose credentials. Preserve the existing permissions, budgets, trading gates, and risk limits.
