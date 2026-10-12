# Design: one world model and one planner for the pets

Status: proposal, no code yet. Written after the maze benchmark showed the current brain solves mazes by wandering and learns nothing from one trial to the next (`docs/baselines/maze-baseline-current-brain.json`).

## The problem with patching

Every new problem (a maze, a one-way door, a charger in a new room) gets its own rule in `system1.ts`. Each rule helps one case, interacts with the others, and teaches the pet nothing general. We want one mechanism that handles all of them, and that we can measure.

## What exists today

| Piece | File | What it gives | What it lacks |
|---|---|---|---|
| Dead-reckoned position | `scenes.ts` | the pet knows roughly where it is, in its own frame | drifts, so it needs correcting |
| Place map | `places.ts` | nodes (pads, doors) and walked edges, with a route planner and `placeSteer` | only two kinds of landmark; no junctions, no dead ends, no "this exit is untried" |
| Prediction | `predict.ts` | running expectations on light, temperature, battery, tone; surprise | nothing about where actions lead |
| Drives and rules | `system1.ts`, `rules.ts` | what the pet wants, and tuned thresholds | each want has its own hand-written way to act |
| Slow thoughts | `system2.ts` | beliefs, suggestions as nudges | not used for steering, and should stay that way |

## The design

**1. One experience graph (grow `places.ts`, do not replace it).**
- A node is any place worth remembering: pad, door, and now a junction or dead end, found when the pet turns, hits a wall, or sees a corridor split.
- Each node lists its exits (bearings from where the pet stood). For each exit we keep: times tried, where it led, whether it came back, and a cost (time and battery spent).
- Edges keep what they already hold (`len`, `n`, `via`), plus an outcome tally.
- Everything is a count or a position. Nothing is a learned weight, so it stays readable and learns from one experience.

**2. One planner (`plan.ts`, new).** Each tick the strongest drive supplies a goal. The planner answers with a steering direction:
1. Is there a known node that satisfies the goal (a pad for a low battery, the way out for "leave")? If yes, take the cheapest known route (the existing `planRoute`).
2. If not, go to the exit with the least information: untried first, then the fewest tries, nearest first. In a maze this is Trémaux's rule. In a house it is "see what is behind that door".
3. If an exit led nowhere, or back to a node already known, mark it spent. When a node has no untried exits left, retreat to the nearest node that does.
4. If an action fails (a one-way door will not open from this side, a dead end), the cost on that edge goes up, so the pet stops trying it.

**3. Surprise corrects the model.** When the outcome of an exit is not what the graph said, `predict.ts` already flags it. We use that to update the edge and to re-localise (below).

**4. Sleep tidies the graph.** The existing night pass merges near-duplicate nodes, keeps the cheapest known route to each goal, and drops edges that stopped being used. That is the route memory: after one successful exit, the pet replays the short route first.

**5. Localisation.** Corridors look alike, so a pet can mistake one junction for another. A new node counts as a known one only if the distance and turns walked since the last node fit its position within a tolerance. Where two candidates fit, the pet keeps both and lets later steps decide (the hypothesis idea from Monty). The first version uses one candidate with a tolerance and reports how often it is wrong, so we know whether the harder version is needed.

### Where Bayes' theorem fits

- **Exit outcomes (steps 1 and 2).** Each exit keeps a Beta-style tally (led somewhere new / dead end / back to a known place). Exits are chosen by sampling from those beliefs, which balances trying new exits against using known ones, and handles doors that sometimes fail. `relations.ts` already scores trust this way.
- **Localisation (step 5).** A small Bayes filter over "which known junction am I at": each observation multiplies the candidates' probabilities and renormalises. This is the formal form of the hypotheses idea and answers the aliasing risk.
- **Not used for:** exploring a deterministic perfect maze (Trémaux cannot be beaten there), the reflexes, or a full Bayesian network over everything.

## What stays fixed

The reflexes in `system1.ts` steps 0 to 3 (no energy, sleep, hold, do not walk into things) and the "being led" behaviour stay as they are, and run before the planner. System 2 stays advice only. The planner sits where steps 5 to 8 (low battery, lonely, tone, curious, wander) now choose a direction; those steps give it a goal instead of steering themselves.

## Why this is one solution

| Problem | How the same planner handles it |
|---|---|
| Maze | goal "get out": untried exits first, retreat from dead ends, replay the route next time |
| Charger in a new room | goal "battery up": known pad if any, else the least-known exit |
| One-way door | the edge fails once or twice, its cost rises, the pet stops pushing |
| Being rescued | the led-out path is added to the graph like any walk |
| Curiosity | "go where I know least" is the same rule with a different goal |

## Steps, each behind a switch, each gated

| Step | Change | Gate to continue |
|---|---|---|
| 1 | Junction and dead-end nodes plus exit tallies in `places.ts`; repair old saves | all tests pass; `maze-bench` unchanged with the switch off |
| 2 | `plan.ts`: untried-exit exploration with retreat | `maze-bench` solves at least as many mazes as the baseline, median time lower |
| 3 | Route memory and night tidy | later trials in the same maze are clearly faster than the first |
| 4 | Goals from drives (battery, curiosity) go through the planner | the house charger-finding test and a house-day run do no worse than today (time on pad, battery low-points); `cost-bench` and `quality-bench` unchanged |
| 5 | Localisation tolerance, then hypotheses if the error rate says so | wrong-merge rate reported; maze result does not fall |
| 6 | Remove superseded hand rules | full suite and benchmarks no worse |

A step that fails its gate is switched off and reported, as with the cost phases.

## Result of steps 1 and 2 (measured)

Built `src/explore.ts`: a count of how often the pet has stepped onto each patch of ground (kept in its place map, in its own frame), and in a passage it goes on straight, turns back at a dead end, and takes the least-trodden opening. It is switched on with `exploreSettings.on` (off by default) or `--explore on` in the maze bench. It does not use junction nodes: the counts do the marking.

Measured against the same pet with it off (first trial only):

| Maze | Mazes | Solved off / on | Median minutes off / on |
|---|---|---|---|
| 8x6 | 24 | 22 / 23 | 25.8 / 32.8 |
| 10x7 | 16 | 14 / 14 | 41.4 / 45.6 |

So the gate (solve at least as many, in a lower median time) is **not met**: it is no better than the current wandering, and slightly slower. Why: the current pet already keeps going straight along corridors, so it behaves like a persistent explorer, and even a perfect depth-first explorer must walk each corridor twice, which is about 4.8x the shortest route in these mazes. The pet already walks 4.8 to 5.4x. There is little left to gain on a first visit. The gain is in later visits, when a remembered route should bring the walk close to 1x. That is step 3, so exploration stays off and the next step is route memory.

## Result of step 3: route memory (measured)

Built `src/route.ts`. While the pet is in a passage it keeps a track of where it has gone with every loop cut out (so it is a path it really walked), sampled along each tick's walk, not just at the end of it. Passing through a doorway turns the track into a remembered way out. Later, when it has been shut in for 2 minutes (or its battery is under 50%), it walks back along its own track to where that meets a remembered way out, then follows that out. Switch: `routeSettings.on` (`--route on` in the bench, `ROUTE_MEMORY=on|off` on the server; by default on only in layouts with puzzle rooms).

Same pet, trial 1 then later trials in the same maze (median minutes, solved, distance walked as a multiple of the shortest route):

| Maze | Trial 1 | Trial 2 | Trial 3 | Trial 4 |
|---|---|---|---|---|
| 8x6, route memory off (baseline) | 25.8 min, 8/8 | 43.5, 6/8 | 24.8, 5/8 | 26.0, 4/8 |
| 8x6, route memory on | 25.8, 8/8, 4.8x | 8.4, 8/8, 2.1x | 8.8, 8/8, 1.9x | 8.2, 8/8, 1.7x |
| 10x7, route memory on (10 mazes) | 24.8, 9/10, 4.5x | 10.2, 9/10, 1.8x | 11.3, 9/10, 1.9x | |

The gate (later trials clearly faster than the first) is met. Raw results: `docs/baselines/maze-route-memory.json`. The first trial is unchanged, as it should be. Later trials are about 3x faster and walk less than half as far, and the remaining time is mostly the 2-minute wait before it wants out.

Two things found on the way. A tick is 5 simulated seconds and up to 150 units of walking, so a doorway could be crossed between two ticks without ever being sensed; the walk now notes a doorway crossed on the way (this also helps the existing place map). And replaying a route has to turn first and walk only as far as the next corner within one tick, or the pet overshoots narrow corridors.

## Risks

- This changes how the pet picks a direction, not just one rule, so regressions are possible. The switches and benchmarks are the guard.
- Position drift can break junction matching. Step 5 measures this before we rely on it.
- The graph must stay bounded (node and exit limits) so old saves and long runs do not grow it without end.
- The rescue still needs its leading fixed (52 of 83 attempts gave up in the 3-day run). That is separate work, and the planner will not replace it.

## Open decisions for you

1. Go ahead with step 1 and 2 first, measured on the maze benchmark?
2. Is it acceptable that the pets' notes mention junctions and dead ends in their own words (no coordinates or room names)?
