curl -s http://localhost:3001/api/logs?limit=3 | python3 -c "
import json, sys
logs = json.load(sys.stdin)['logs']
for l in logs:
    if 'reject' in l['action']:
        d = json.loads(l['details'])
        print(f\"Action: {l['action']}\")
        print(f\"Ref:    {d.get('ref')}\")
        print(f\"Error:  {d.get('error')}\")
        break
"