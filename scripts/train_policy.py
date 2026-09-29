"""Offline tabular Q-learning experiment. Approximate inventory model, NOT organizer simulator.
Fixed train/test seeds. No network calls, dispatches, or deployment promotion.
"""
import json, math, random
from pathlib import Path
ACTIONS = [0, 2000, 4000, 6000]

def state(inv, incoming, demand):
    return f'{min(9,int(inv/1000))}:{min(6,int(sum(x[1] for x in incoming)/1000))}:{min(3,int(demand/200))}'

def episode(seed, policy, q, training=False):
    rng = random.Random(seed)
    inv, incoming, previous = 5000., [], 300.
    unmet = demand_total = shipped = reward_total = 0.
    for t in range(96):
        s = state(inv, incoming, previous)
        values = q.setdefault(s, [0.] * len(ACTIONS))
        if policy == 'q_learning':
            action = rng.randrange(4) if training and rng.random() < .15 else max(range(4), key=lambda a: values[a])
        else:
            position = inv + sum(x[1] for x in incoming)
            action = min(range(4), key=lambda a: abs(ACTIONS[a] - max(0, 6500-position))) if position < 3500 else 0
        qty = min(ACTIONS[action], max(0, 10000-inv-sum(x[1] for x in incoming)))
        if qty: incoming.append((t+3, qty))
        inv += sum(x[1] for x in incoming if x[0] == t)
        incoming = [x for x in incoming if x[0] > t]
        demand = max(0, (300 + 100*math.sin(t/96*math.pi*2)) * (1.9 if seed%3 == 0 and 30<=t<65 else 1) * rng.uniform(.8, 1.2))
        lost = max(0, demand-inv); inv = max(0, inv-demand)
        reward = -10*lost - .005*inv - .015*qty - (20 if qty else 0)
        ns = state(inv, incoming, demand)
        next_values = q.setdefault(ns, [0.]*4)
        if training: values[action] += .15 * (reward + (.95*max(next_values) if t<95 else 0) - values[action])
        unmet += lost; demand_total += demand; shipped += qty; reward_total += reward; previous = demand
    return {'unmetLiters':unmet,'demandLiters':demand_total,'shippedLiters':shipped,'reward':reward_total,'serviceLevel':1-unmet/demand_total}

q = {}
for seed in range(2500): episode(seed, 'q_learning', q, True)
results = {}
for policy in ['q_learning','reorder_point']:
    rows = [episode(seed, policy, q) for seed in range(10000,10100)]
    results[policy] = {k: sum(r[k] for r in rows)/len(rows) for k in rows[0]}
artifact = {'version':'tabular-q-1.0.0','environment':'Approximate single-station inventory surrogate; not official simulator',
    'trainingEpisodes':2500,'testEpisodes':100,'trainSeeds':[0,2499],'testSeeds':[10000,10099],
    'state':'inventory bin, pipeline inventory bin, previous-demand bin','actionsLiters':ACTIONS,
    'reward':'-10*unmet -0.005*inventory -0.015*shipment -20 per dispatch',
    'results':results,'promotion':'research only; never dispatches. Official-simulator validation required before adoption.',
    'qTable':q}
Path('apps/api/src/intelligence/rl-policy.json').write_text(json.dumps(artifact))
Path('docs/evidence/rl-evaluation.json').write_text(json.dumps({k:v for k,v in artifact.items() if k!='qTable'}, indent=2))
print(json.dumps(results, indent=2))
