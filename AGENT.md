# AGENT.md — 1000pets

## Project Summary

`1000pets` is an experimental artificial-life / Pet Brain project.

The current goal is to build a **software-only 2D multi-pet simulator** in which several pets live continuously, perceive the world through limited virtual sensors, learn from experience, form memories, make predictions, develop relationships, create persistent intentions, and communicate in English through an AI language layer.

This is **not** primarily an LLM chatbot project.

The LLM is a language and interpretation layer. Core cognition must live in the Pet Brain.

---

## Current Phase

We are working in the **simulation** (2D rules, drawn in 3D in the browser), not ESP32 hardware. It is running: 3 pets, a human avatar, a room with
sun, lamp, heater and a charger with a steady hum, accelerated simulated time, and a tabbed web dashboard.
Built so far: System 1/System 2 brains, scene memory, sleep consolidation, dreams, prediction and surprise,
belief verification, optional self-tuned habits (off by default), an AI Teacher, simulation saves, and per-pet
brain export/import, relationships, a four-room house with doors, a 3D view, and spoken voices. `HANDOFF.md` is the source of truth for current behaviour and what is not done.

The original starting goals for the experiment were:

The first serious experiment should support:

- 3 pets
- 1 human participant
- 1 simple room
- one main light/window source
- a few objects
- accelerated simulated time
- approximately 30 simulated days of lived experience in a few real hours

No application code should skip directly to physical hardware architecture.

---

## Core Architecture

```text
2D World
   ↓
Virtual Sensors
   ↓
Pet Brain
   ↓
Intent / Plan
   ↓
Actions
   ↓
World changes
```

English communication is separate:

```text
Pet Brain state
   ↓
LLM expression
   ↓
English
```

and:

```text
English input
   ↓
LLM interpretation
   ↓
structured meaning
   ↓
Pet Brain
```

---

## Non-Negotiable Design Rules

1. **Pets are not omniscient.** They never receive the full authoritative world state.
2. **Each pet has isolated state.** Shared architecture does not mean shared memory, beliefs, relationships, or intentions.
3. **LLMs do not decide core wants.** Drives, predictions, intent, and planning belong in the Pet Brain.
4. **Thought is not English.** Internal cognition should use structured concepts and state.
5. **LLM calls are event-driven.** Never call the model every simulation tick.
6. **Speech from other pets is a claim, not truth.** Allow verification and trust formation.
7. **Core drives stay controlled.** Learned goals can evolve underneath stable drives.
8. **No arbitrary self-rewriting firmware/code as a default behavior.** Prefer validated policy/configuration changes.
9. **Behavior should be explainable.** Important actions/speech should be traceable to observation → memory/belief → drive → intent → plan.
10. **Simulation time is independent of wall-clock time.** Long experience runs must be accelerated.

---

## Thousand Brains Inspiration

Use Jeff Hawkins / Thousand Brains ideas as architectural inspiration, not as a claim of biological equivalence.

Important concepts:

- sensorimotor learning
- multiple reusable models
- lateral model communication
- competing hypotheses / consensus
- reference frames
- hierarchical models
- outputs of learned models may become inputs to higher-order learned models

Early model examples:

```text
LightModel
SpatialModel
EntityModel
PetModel
HumanModel
EnergyModel
TimeModel
```

Later:

```text
InteractionModel
RoutineModel
PlaceModel
RelationshipModel
```

---

## Initial Virtual Sensors

Prioritize:

- vision cone
- light
- proximity/distance
- touch
- orientation/motion
- energy

Temperature and hearing can follow early.

Sensors should later map cleanly to real ESP32 hardware.

---

## Pet Brain Modules

Target abstractions:

```text
Perception
World Models
Memory
Prediction
Drives
Curiosity
Emotion State
Intentions
Planner
Language Interface
```

Memory should eventually include:

- working
- episodic
- semantic
- routine
- relationship

---

## Drives

Start small:

```text
Energy
Curiosity
Social
Rest
```

Later add comfort/safety if needed.

Drives generate candidate intentions when combined with memory, prediction, and current world beliefs.

---

## Persistent Intent

Intentions must be able to survive multiple simulation ticks and possibly multiple simulated days.

Example:

```text
"understand why the morning light changed"
```

The planner should decompose intentions into subgoals/actions and re-plan when evidence changes.

---

## Social Behavior

Pets should gradually recognize persistent entities.

Do not initialize another pet as automatically “friend.”

Relationships should emerge from:

- repeated encounters
- communication
- verified claims
- proximity
- interaction outcomes

Relationships may be asymmetric.

---

## Human Interaction

Support two modes:

### Observer Mode
Can inspect hidden/internal state for debugging and experiments.

### Participant Mode
The human exists as another world entity and communicates spatially.

Chat should allow targeting:

```text
Pet A
Pet B
Pet C
Everyone
```

Answers must be grounded in actual pet state.

---

## Time Acceleration

Required.

Suggested speed modes:

```text
1×
10×
100×
1000×
```

At high speeds:

- keep simulation and cognition active
- avoid unnecessary LLM speech generation
- preserve semantic communication events
- allow later inspection/summarization

A target early run is ~30 simulated days in ~1–3 real hours.

---

## Recommended Stack

Backend:

```text
Python
FastAPI
SQLite
```

Frontend:

```text
React / Next.js
```

Keep the first UI functional and research-oriented rather than visually elaborate.

---

## Near-Term Implementation Order

1. simulation clock + deterministic random seed
2. authoritative 2D world state
3. multiple pet bodies
4. movement/orientation
5. virtual sensor interface
6. energy + basic drives
7. isolated working/episodic memory
8. simple learned world models
9. prediction + prediction error
10. curiosity-triggered investigation
11. persistent intent engine
12. planner
13. pet entity recognition
14. relationship state
15. event-driven LLM language layer
16. human observer/participant UI
17. accelerated 30-day experiment
18. hierarchical learned models
19. later ESP32 adapter

---

## Testing Philosophy

Prefer reproducible experiments over subjective demos.

Every run should be configurable by:

```text
seed
brain version
world version
scenario
initial traits
simulation duration
```

Compare runs on:

- prediction accuracy
- learned models
- number/type of persistent intentions
- adaptation to anomalies
- relationships
- communication patterns
- LLM call count

Use the same seed when comparing brain algorithm changes.

---

## First Milestone

The first meaningful milestone is complete when:

- 3 pets coexist in one 2D world
- each receives only local observations
- each maintains separate memory and beliefs
- pets learn a repeated light/routine pattern
- a deliberate anomaly produces prediction error
- at least one pet investigates due to curiosity
- pets maintain persistent intentions
- pets remember each other
- pets communicate in English through an LLM
- the user can pause and ask what each pet learned and why it is acting
- ~30 simulated days can run in a few real hours

---

## Future Hardware

Eventually add an ESP32-S3 implementation under `hardware/esp32/`.

Likely physical sensors:

- camera
- microphone
- IMU
- ambient light
- temperature/humidity
- ToF distance
- capacitive touch
- speaker
- battery/fuel monitoring
- optional solar input

The physical device should implement the same logical sensor interface as the simulator.

The long-term goal is for virtual and physical pets to share the same Pet Brain architecture.
