# 1000pets

## Pet Brain Simulator / Multi-Pet Artificial Life Research Project

`1000pets` is an experimental artificial-life project focused on building virtual and eventually physical AI pets that **continue to exist, learn, remember, form expectations, develop relationships, and maintain persistent goals even when no human is actively talking to them**.

The project begins as a **software-only 2D multi-pet simulator** and is intended to evolve toward a physical ESP32-S3 pet body with camera, microphone, motion sensing, environmental sensors, speaker output, local storage, and cloud or local AI language support.

The long-term goal is not to build a chatbot inside a cute shell. The goal is to explore whether a small embodied agent can gradually construct its own useful model of its environment, other pets, and its human through repeated experience.

---

# 1. Core Vision

The central idea is:

> Build an artificial pet whose behavior is grounded in its own persistent internal state, memories, learned world models, predictions, drives, and intentions, while using an LLM mainly as a language interface.

The pet should not behave like this:

```text
human says something
    ↓
LLM responds
    ↓
interaction ends
```

It should behave more like this:

```text
world continues
    ↓
sensors observe
    ↓
brain updates beliefs
    ↓
needs change
    ↓
predictions succeed or fail
    ↓
curiosity / goals emerge
    ↓
actions happen
    ↓
memories accumulate
    ↓
relationships and routines develop
```

The pet may speak through an LLM, but its cognition should not be equivalent to an LLM prompt.

---

# 2. Feeling Alive vs. Being Conscious

This project does **not** assume or claim that the pet is conscious or sentient.

The engineering target is instead to create a system that can **feel alive to interact with** because it exhibits:

- continuity of existence
- memory across interactions
- autonomous initiative
- internal needs
- persistent goals
- learned expectations
- prediction errors and surprise
- selective attention
- social relationships
- different behavior under different internal states
- physical or simulated embodiment
- occasional silence rather than constant response
- different development depending on experience

A useful test is whether the user stops asking:

> “What can this AI do?”

and starts wondering:

> “What is my pet doing right now?”

---

# 3. Why Start With a Simulator

The project starts with a **Pet Brain Simulator** because long-term development is difficult to test using only real hardware.

A simulator allows:

- days or months of lived experience to be compressed into hours
- reproducible experiments
- multiple pets to be run in parallel
- controlled disturbances and anomalies
- repeated runs with the same random seed
- comparison of learning algorithms
- inspection of internal memories and models
- testing before ESP32 hardware integration

The same Pet Brain should eventually be usable with either:

```text
Virtual sensors
      ↓
   Pet Brain
```

or:

```text
ESP32 sensors
      ↓
   Pet Brain
```

The cognition layer should not need to know whether the data came from simulation or physical hardware.

---

# 4. Simulation Time vs. Real Time

A key design principle is that **simulated experience time is independent of wall-clock runtime**.

For example:

```text
1 real second = 5 simulated minutes
```

Then:

```text
1 simulated day  = 4.8 real minutes
30 simulated days = 144 real minutes
                  = 2.4 real hours
```

Therefore, a “30-day simulation” means **30 days of pet experience**, not 30 real days.

The simulator should support speed modes such as:

```text
1×      interactive mode
10×     accelerated mode
100×    fast simulation
1000×   batch/research mode
```

Different subsystems do not need to update at the same rate.

Example:

```text
world/physics update      frequent
sensor sampling           frequent
brain update              every few simulated minutes
routine learning          hourly
memory consolidation      daily
LLM language calls        event-driven only
```

At high speeds, internal semantic interactions can be recorded without generating natural-language dialogue for every event.

---

# 5. Big-Picture Architecture

```text
                    HUMAN / OBSERVER
                          │
                 chat / intervention
                          │
                          ▼
                  AI LANGUAGE LAYER
               understand / express English
                          │
                          ▼
┌────────────────────────────────────────────────┐
│                 PET BRAINS                     │
│                                                │
│ Pet A          Pet B          Pet C            │
│ ├ models       ├ models       ├ models         │
│ ├ memory       ├ memory       ├ memory         │
│ ├ drives       ├ drives       ├ drives         │
│ ├ intent       ├ intent       ├ intent         │
│ └ planner      └ planner      └ planner        │
└───────────────────────┬────────────────────────┘
                        │
                        ▼
                ACTION / BEHAVIOR LAYER
                        │
                        ▼
┌────────────────────────────────────────────────┐
│                  2D WORLD                      │
│                                                │
│ pets • objects • walls • light • temperature  │
│ sounds • touch events • day/night • human     │
└───────────────────────┬────────────────────────┘
                        │
                        ▼
                 VIRTUAL SENSORS
                        │
                        └──────────────► Pet Brains
```

The world is authoritative. Pets are not omniscient.

Each pet only knows what it can infer from its own sensors, memories, communication, and learned models.

---

# 6. 2D Multi-Pet World

The first environment should be intentionally simple.

Example:

```text
┌─────────────────────────────────────────────┐
│ Window ☀                                   │
│                                             │
│        Pet A               plant            │
│                                             │
│                    table                    │
│                                             │
│             Pet B                           │
│                                   Pet C     │
│                                             │
│                                   Door      │
└─────────────────────────────────────────────┘
```

The 2D world should include:

- x/y position
- pet orientation
- walls and obstacles
- one or more light sources
- day/night cycle
- temperature or environmental zones
- objects
- human/player entity
- pets
- sounds
- touch events
- energy sources

The first version does not need sophisticated physics.

---

# 7. World State

The simulator should maintain one objective `WorldState`.

Example conceptually:

```json
{
  "simulation_time": "Day 4 08:15",
  "sun_intensity": 0.72,
  "temperature": 21.4,
  "objects": [
    {"type": "window", "x": 800, "y": 50},
    {"type": "plant", "x": 500, "y": 200}
  ]
}
```

Pets must never receive the complete world state.

Instead:

```text
WorldState
   ↓
Sensor simulation
   ↓
Pet-specific observations
```

This prevents omniscience and allows genuine uncertainty.

---

# 8. Pet Bodies

Each pet has a body independent of its brain.

Example state:

```text
position
orientation
velocity
energy
comfort
sleep state
sensor health
```

Later versions may include:

- age
- physical health
- body size
- motor ability
- damaged sensors
- battery state
- charging state

The body is the Pet Brain’s interface to the environment.

---

# 9. Virtual Sensors

The virtual sensors should mirror hardware that can later exist on an ESP32-S3 pet.

## 9.1 Vision

A pet should only perceive within its field of view.

```text
        vision cone

            /\
           /  \
          /    \
         /      \
        PET
```

Possible observation:

```json
{
  "entity": "unknown_moving_object",
  "distance": 84,
  "bearing": 17,
  "confidence": 0.83
}
```

The virtual vision system should initially provide abstract detections rather than actual image pixels.

Later, rendered images or real camera input can be introduced.

## 9.2 Hearing

Sound should have:

- source position
- volume
- duration
- category if available
- possible speaker identity

Pets should hear based on distance and obstruction.

Speech is not a magical global channel.

## 9.3 Proximity / Distance

Provides distance and bearing to nearby obstacles or entities.

This maps well to future ToF hardware such as VL53L1X.

## 9.4 Light

Light depends on:

- source strength
- pet location
- orientation
- obstacles
- time of day

The pet can therefore learn that certain places and times produce more light.

## 9.5 Temperature

Temperature may vary by zone or time.

Examples:

- warm window area
- cool doorway
- heater zone
- colder night period

## 9.6 Touch

Touch events can include:

- human touches pet
- pet bumps pet
- pet touches object
- prolonged touch
- body-region information

Touch should eventually support body-relative reference frames.

## 9.7 Orientation / Motion

Virtual IMU data can indicate:

- turning
- movement
- pick-up equivalent events
- rotation
- sudden movement

This later maps naturally to a physical IMU.

## 9.8 Energy

Energy should be partly grounded in environment and action.

Examples:

- movement consumes energy
- idling consumes less
- charging or sunlight restores energy
- low energy increases related drives

---

# 10. Pet Brain Structure

Each pet runs the same general software architecture, but its internal state is isolated.

```text
PetBrain
│
├── Perception
├── World Models
├── Memory
├── Prediction
├── Drives
├── Emotion State
├── Curiosity
├── Intentions
├── Planner
└── Language Interface
```

The key principle is:

```text
same architecture
≠
same life
```

Different experiences should lead to different memories, beliefs, relationships, intentions, and possibly personality drift.

---

# 11. Thousand Brains Inspiration

The project is partly inspired by Jeff Hawkins’ *A Thousand Brains* theory and related Thousand Brains Project ideas.

The project does **not** claim to reproduce the neocortex.

Instead, it borrows several architectural principles.

## 11.1 Sensorimotor Learning

Intelligence should not come from passive perception only.

A pet acts, senses the result, and learns from the relationship.

Example:

```text
turn left
   ↓
light increases
   ↓
learn relationship between action, orientation and light
```

## 11.2 Multiple Models

Instead of one monolithic `WORLD_MODEL`, the pet may maintain multiple specialized models.

Examples:

```text
LightModel
TemperatureModel
SpatialModel
HumanModel
PetModel
EnergyModel
TimeModel
SoundModel
```

## 11.3 Lateral Communication

Models should be able to exchange evidence or hypotheses.

```text
SpatialModel ←→ LightModel
      ↕            ↕
   PetModel ←→ HumanModel
```

## 11.4 Consensus / Hypothesis Competition

Different models may propose competing explanations.

Example:

```text
Morning anomaly       0.82
Weekend pattern       0.41
Human sleeping        0.62
Curtain closed        0.55
```

New evidence updates those confidences.

## 11.5 Hierarchical Models

The project should eventually support models built from the outputs of other models.

```text
raw sensor
   ↓
feature
   ↓
event
   ↓
routine
   ↓
abstract concept
```

Example:

```text
light increase
+
human touch
+
movement
      ↓
"moved toward window"
      ↓
repeated sequence
      ↓
"morning window routine"
```

The long-term experimental direction is that learned models can themselves become inputs into new higher-order models.

## 11.6 Reference Frames

Possible reference frames include:

### Body reference frame

```text
head touch
left side
right side
front
back
```

### Room reference frame

```text
window
wall
social area
quiet area
energy-rich area
```

### Time reference frame

```text
morning
working period
evening
weekend
```

Higher-level contextual reference frames may also be explored experimentally.

---

# 12. Memory System

The pet should have several levels of memory.

## 12.1 Working Memory

Short-lived recent context.

Examples:

- latest observations
- current interaction
- recent movement
- current goal

## 12.2 Episodic Memory

Specific experiences.

Example:

```json
{
  "time": "Day 4 08:04",
  "event": "moved_toward_window",
  "before_light": 22,
  "after_light": 89,
  "energy_change": 4
}
```

## 12.3 Semantic Memory

Learned facts or concepts.

Examples:

```text
window area → bright in morning
Pet B → usually approaches peacefully
Don → known human
```

## 12.4 Routine Memory

Repeated patterns.

Examples:

```text
morning window routine
human returns in evening
weekends are less predictable
```

## 12.5 Relationship Memory

Tracks persistent social experience with specific entities.

Examples:

```text
familiarity
trust
interaction frequency
predictability
response history
```

---

# 13. Prediction

Prediction is a core mechanism.

The pet should not only store facts; it should predict what happens next.

Example:

```text
Current:
Day 12, 07:55
weekday
window location

Prediction:
light at 08:10 ≈ 65
```

If actual light is 8, prediction error becomes large.

```text
prediction error = expected - observed
```

Prediction error is one of the main signals for learning and curiosity.

---

# 14. Curiosity

Curiosity should come from uncertainty, novelty, and prediction error rather than random LLM roleplay.

Possible conceptual formula:

```text
curiosity = prediction_error × novelty × confidence
```

High curiosity may cause:

- observation
- movement
- checking another direction
- waiting for more evidence
- asking another pet
- asking the human

---

# 15. Drives

Initial core drives may include:

```text
Energy
Comfort
Curiosity
Social
Rest
Safety
```

Example:

```text
energy_need    0.72
curiosity      0.44
social_need    0.31
rest_need      0.15
```

These should be more stable than transient goals.

---

# 16. Intent Engine

The pet should be able to generate intentions from:

```text
drives
+
world models
+
prediction error
+
memory
+
personality
+
current context
```

Example:

```text
Energy low
Light lower than expected
Bright window remembered

Candidate intents:
seek light          0.88
talk to Pet B       0.32
explore object      0.41
sleep               0.18
```

The selected goal becomes an active intention.

---

# 17. Persistent Long-Term Intent

An important project goal is to support intentions that survive individual interactions.

Example:

```json
{
  "goal": "understand Pet B morning absence",
  "created_day": 14,
  "priority": 0.48,
  "progress": 0.37,
  "observations": 5
}
```

The pet may continue investigating over multiple simulated days.

This is called **persistent computational intent** in this project.

It is not a claim of consciousness or philosophical free will.

---

# 18. Planner

Intentions should produce subgoals and actions.

Example:

```text
Intent:
understand missing sunlight

Plan:
1. turn toward expected window direction
2. measure light
3. compare with previous mornings
4. wait
5. ask another pet
6. ask human if uncertainty remains high
```

Plans can change as new evidence appears.

---

# 19. Personality

Pets may begin with small trait differences.

Example:

```text
Pet A
curiosity    0.80
social       0.70
caution      0.20
patience     0.40

Pet B
curiosity    0.30
social       0.40
caution      0.80
patience     0.80
```

Personality may drift modestly through experience, but should not be arbitrarily rewritten by an LLM.

---

# 20. Relationships Between Pets

Relationships should emerge from interaction history.

Pet A may model Pet B as:

```text
familiarity     0.81
trust           0.73
interaction     0.64
predictability  0.55
```

Pet B may model Pet A differently.

Relationships are therefore not necessarily symmetric.

---

# 21. Pets Should Learn Each Other as Entities

The system should avoid hardcoding social meaning too early.

A pet may initially perceive:

```text
unknown moving object
```

After repeated encounters:

```text
persistent entity
```

Later:

```text
another pet
```

Later still:

```text
familiar / trusted / unpredictable / social
```

This allows identity and relationship concepts to develop through experience.

---

# 22. Pet-to-Pet Communication

Pets should be able to communicate in English through an AI language layer.

But communication must be grounded in Pet Brain state.

Example internal intent:

```json
{
  "intent": "inform_pet",
  "target": "PetB",
  "subject": "light",
  "information": "this location has stronger light"
}
```

LLM output:

> “Hey, it’s brighter over here.”

Pet B hears that and parses it back into a structured claim.

Pet B should not treat the statement as fact automatically.

Instead:

```text
Pet A claims location X is bright
```

Pet B may verify it independently.

This allows trust to develop.

---

# 23. Social Knowledge and Trust

If Pet A tells Pet B something and Pet B later confirms it, trust can increase slightly.

Example:

```text
Pet A claim:
window corner is bright

Pet B verifies:
true

trust(PetA) += small amount
```

Future work may explore:

- conflicting claims
- uncertainty
- social learning
- misinformation
- trust calibration
- teaching

The project should avoid intentionally deceptive design as a core feature.

---

# 24. Human as Third-Party Participant

The user participates as another entity in the world.

Two modes are useful.

## 24.1 Observer Mode

Research/debug mode.

The user can inspect:

- all pet states
- all memories
- predictions
- intentions
- model confidence
- hidden world state

## 24.2 Participant Mode

The user interacts as `Human_001` or another world entity.

The user may:

- talk to one pet
- talk to all pets within hearing range
- move objects
- touch pets
- change the environment
- leave the room
- return later

Speech should have spatial range rather than being automatically global.

---

# 25. Human Chat

The UI should allow selection of:

```text
Pet A
Pet B
Pet C
Everyone
```

The same user question may produce different answers because each pet has different internal state.

Example:

> “Why are you all standing by the window?”

Pet A:

> “I was checking why the light changed.”

Pet B:

> “I followed A. It seemed worth checking.”

Pet C:

> “Mostly because everyone else came over.”

The answers should be grounded in actual brain state.

---

# 26. Role of the LLM

The LLM is **not the primary brain**.

The LLM should mainly handle:

- English generation
- English interpretation
- summarization
- occasional semantic consolidation
- naming learned concepts
- possibly complex ambiguous language understanding

The LLM should not directly decide:

- what the pet fundamentally wants
- its core drives
- what really happened
- whether a sensor reading is true
- its persistent goals by pure roleplay

Bad architecture:

```text
sensor
  ↓
LLM
  ↓
everything
```

Preferred architecture:

```text
sensor
  ↓
Pet Brain
  ↓
intent / belief / decision
  ↓
LLM
  ↓
English expression
```

---

# 27. Thought Is Not Language

Internally, pets should operate on structured concepts.

Example:

```text
ENTITY_4
LOCATION_7
BRIGHT
APPROACH
FAMILIAR
CLAIM
```

English is an external communication representation.

This prevents cognition from becoming dependent on prose generation.

---

# 28. LLM Usage Must Be Event-Driven

Do not call an LLM on every simulation tick.

Typical LLM triggers:

```text
pet decides to speak
human speaks
another pet speaks
semantic memory consolidation
concept naming
```

At high simulation speed, store semantic communication directly where appropriate and avoid unnecessary natural-language generation.

---

# 29. Debug / Observer Dashboard

Clicking a pet should reveal something like:

```text
PET A
──────────────────

BODY
Energy       68%
Comfort      92%

DRIVES
Curiosity    77%
Social       34%
Rest         21%

CURRENT INTENT
Investigate dark window

WORLD BELIEFS
Window → usually bright        0.92
Pet B → friendly               0.71
Don → known human              0.83

PREDICTIONS
Morning light expected         0.88
Human interaction likely       0.64

MEMORIES
57 episodic
18 semantic

CURRENT PLAN
1. approach window
2. measure light
3. compare previous mornings
4. ask another pet
```

The debugger should make it possible to determine whether behavior came from real internal state or LLM invention.

---

# 30. Explainability of Speech

For each important sentence, the debug view should be able to answer:

```text
WHY DID THE PET SAY THIS?

intent:
answer_human_question

brain evidence:
- current goal: investigate window
- observed light anomaly
- Pet B nearby

LLM task:
express explanation naturally

LLM output:
"I was checking why the light changed."
```

This is important for research and debugging.

---

# 31. Example Early Scenario

Three pets begin with nearly identical architecture but slightly different personality parameters.

```text
Pet A = curious
Pet B = cautious
Pet C = social
```

## Early Experience

At simulation start, they do not meaningfully understand:

```text
window
human
other pets
room
routine
```

### Encounter

Pet C sees Pet A as an unknown moving entity.

C’s social drive causes a communication attempt.

LLM expression:

> “Hello?”

Pet A responds:

> “Hi. What are you?”

### Human Introduction

The user enters and says:

> “Hello everyone. I’m Don.”

Only pets that hear clearly should store the information directly.

A distant pet may later ask another pet who the human was.

This lets social knowledge spread indirectly.

---

# 32. Example Light-Learning Scenario

Over multiple simulated days, Pet A learns:

```text
window area → stronger morning light
```

Pet A tells Pet B:

> “That corner gets really bright in the morning.”

Pet B stores it as a claim rather than fact.

The next morning Pet B verifies the claim.

Trust toward Pet A increases slightly.

---

# 33. Example Prediction Error Scenario

After the pets learn a morning light routine, the simulation deliberately changes the environment.

For example:

```text
curtain remains closed
```

Pet A predicts bright morning light but observes darkness.

```text
prediction error ↑
curiosity ↑
```

It may:

1. move toward the expected light location
2. check another direction
3. ask Pet C whether it is dark there too
4. ask the human whether something changed

This is a key early experiment.

---

# 34. Developmental Divergence

After sufficient experience, identical or nearly identical pets should diverge.

Possible result:

## Pet A

```text
strong environmental/light interest
high exploration
strong spatial model
```

## Pet B

```text
strong routine model
high caution
good prediction consistency
```

## Pet C

```text
strong social model
large relationship memory
high communication frequency
```

The goal is that differences emerge from both initial traits and lived experience.

---

# 35. First Major Experiment

The first serious milestone should be:

```text
3 pets
1 human
1 room
1 window/light source
a few objects
```

Sensors:

```text
vision
light
distance
touch
orientation
```

Drives:

```text
energy
curiosity
social
rest
```

Brains:

```text
memory
prediction
intent
planner
```

Language:

```text
LLM-assisted English communication
```

The simulation should produce the equivalent of roughly 30 days of lived experience in a few real hours.

At the end, pause and ask each pet:

- What place do you like?
- Who is Pet B?
- What usually happens in the morning?
- What are you trying to do right now?

Each answer should be different where appropriate and grounded in actual learned state.

---

# 36. Research Questions

The project can investigate questions such as:

1. Can a small artificial creature build useful environmental models from sparse multimodal experience?
2. Can persistent intentions emerge from drives, prediction error, and memory without asking an LLM what the pet “wants”?
3. Can learned models themselves become inputs to higher-order models?
4. Do multiple distributed models improve robustness compared with a monolithic state machine?
5. Can social trust emerge from claims and independent verification?
6. Can several identical pets develop measurably different world models and relationships?
7. Can a language model serve as a communication layer without dominating cognition?
8. Can the same Pet Brain architecture transfer from simulation to physical ESP32 hardware?

---

# 37. Comparison to Existing AI Pets

Many existing AI pets already combine some of:

- sensors
- persistent memory
- voice interaction
- adaptive behavior
- expressive animation

The distinctive research direction of `1000pets` is the attempt to combine:

```text
embodied sensing
+
distributed learned models
+
prediction
+
prediction error
+
curiosity
+
persistent intent
+
relationships
+
long-term development
+
LLM language interface
```

The project is therefore closer to an artificial-life and embodied cognition experiment than a standard LLM companion.

---

# 38. Recommended Initial Technology Stack

## Backend

```text
Python
FastAPI
```

Python is a good fit for:

- simulation
- agent logic
- learning experiments
- data analysis
- future research integrations

## Storage

Start with:

```text
SQLite
```

Possible stored data:

- episodic memory
- semantic memory
- model state
- pet relationships
- experiment metadata
- snapshots

## Frontend

Suggested:

```text
React / Next.js
```

The frontend should provide:

- 2D world visualization
- pet selection
- observer mode
- participant chat
- simulation speed control
- time display
- debugger panels
- experiment start/pause/reset

A simpler frontend is acceptable for the earliest prototype if it speeds up experimentation.

---

# 39. Proposed Repository Structure

```text
1000pets/
│
├── README.md
├── AGENT.md
│
├── backend/
│   ├── api/
│   ├── simulation/
│   │   ├── world.py
│   │   ├── clock.py
│   │   ├── environment.py
│   │   ├── objects.py
│   │   └── events.py
│   │
│   ├── pet/
│   │   ├── body.py
│   │   ├── sensors.py
│   │   ├── perception.py
│   │   ├── drives.py
│   │   ├── emotions.py
│   │   ├── curiosity.py
│   │   ├── intent.py
│   │   ├── planner.py
│   │   └── brain.py
│   │
│   ├── models/
│   │   ├── light_model.py
│   │   ├── spatial_model.py
│   │   ├── entity_model.py
│   │   ├── human_model.py
│   │   ├── pet_model.py
│   │   └── routine_model.py
│   │
│   ├── memory/
│   │   ├── working.py
│   │   ├── episodic.py
│   │   ├── semantic.py
│   │   ├── relationship.py
│   │   └── repository.py
│   │
│   ├── language/
│   │   ├── provider.py
│   │   ├── interpretation.py
│   │   ├── expression.py
│   │   └── schemas.py
│   │
│   └── experiments/
│       ├── baseline.py
│       ├── thirty_day.py
│       ├── anomaly.py
│       └── comparison.py
│
├── frontend/
│   ├── world/
│   ├── chat/
│   ├── debugger/
│   └── experiments/
│
├── data/
│   ├── simulations/
│   ├── snapshots/
│   └── seeds/
│
└── hardware/
    └── esp32/
```

This structure is directional, not mandatory.

---

# 40. Development Phases

## Stage 0 — Foundation

- project structure
- simulation clock
- deterministic seed support
- world state

## Stage 1 — Multi-Pet World

- multiple pets
- movement
- orientation
- basic objects

## Stage 2 — Virtual Sensors

- vision
- light
- distance
- touch
- orientation

## Stage 3 — Internal Drives

- energy
- curiosity
- social
- rest

## Stage 4 — Memory

- working memory
- episodic memory
- semantic memory

## Stage 5 — World Models

- light
- space
- entities
- human
- other pets

## Stage 6 — Prediction

- expected observations
- prediction errors
- confidence

## Stage 7 — Intent Engine

- candidate goals
- priority
- persistence

## Stage 8 — Planner

- goal decomposition
- action selection
- replanning

## Stage 9 — Pet Recognition

- persistent entities
- familiarity
- identity

## Stage 10 — LLM Language Layer

- brain state to English
- English to structured meaning
- event-driven calls

## Stage 11 — Human Participant Interaction

- pet-specific chat
- spatial speech range
- observer vs participant mode

## Stage 12 — Relationships

- familiarity
- trust
- interaction history

## Stage 13 — Model Hierarchy

- event models
- routine models
- models consuming model outputs

## Stage 14 — Learned Concepts

- recurring structure detection
- model creation
- semantic naming

## Stage 15 — Long-Run Experiments

- accelerated simulated time
- 30-day lived-experience runs
- reproducible seeds
- algorithm comparisons

## Stage 16 — Physical ESP32 Pet

- hardware sensor adapter
- real camera/microphone/IMU/light/temperature/distance
- speaker output
- SD storage where useful

---

# 41. Experiment Methodology

The simulator should support reproducibility.

Each experiment should be identifiable by:

```text
random seed
brain version
world version
pet initial traits
simulation duration
speed
scenario configuration
```

Example comparison:

```text
Run A
seed 12345
curiosity model v1

Run B
seed 12345
curiosity model v2
```

Then compare:

- learned models
- prediction accuracy
- number and type of intentions
- relationships
- communication patterns
- API usage
- energy behavior
- adaptation after anomalies

---

# 42. Hardware Direction

The eventual physical pet is expected to use an ESP32-S3-class board.

Potential hardware components discussed include:

- ESP32-S3
- camera
- 32 GB microSD
- microphone
- IMU
- ambient light sensor
- temperature/humidity sensor
- ToF proximity sensor
- capacitive touch
- speaker + I2S amplifier
- battery / fuel monitoring
- optional solar panel and solar current/voltage sensing
- optional servos for active perception

Possible sensor roles:

```text
camera       → external vision
microphone   → hearing / speech / ambient audio
IMU          → body movement / orientation
BH1750       → objective ambient light
BME280/SHT31 → temperature / humidity
VL53L1X      → distance / proximity
touch        → social physical interaction
speaker      → voice / non-verbal expression
battery      → physically grounded energy state
solar        → physically grounded energy intake
```

The physical device should eventually implement a `SensorProvider` interface equivalent to the simulator.

---

# 43. Important Architectural Boundaries

## 43.1 Do not make the LLM the entire brain

The LLM should not replace memory, prediction, drives, or intent.

## 43.2 Do not give pets omniscient world access

Pets receive only sensor-derived observations and communication.

## 43.3 Do not automatically trust speech

Statements from other pets are claims until independently verified or trusted through experience.

## 43.4 Do not freely rewrite core firmware or core values

Earlier exploration considered AI-generated Lua or firmware rewriting. That is not the preferred default architecture.

Use controlled, validated configuration or policy changes instead.

## 43.5 Keep core drives stable

Core drives should be controlled by the system.

Learned goals may evolve underneath them.

## 43.6 Separate objective state from character expression

The pet may exaggerate playfully, but should not present fake sensor failures as objective reality.

## 43.7 Explainability matters

Important behavior and speech should be traceable to:

- observation
- memory
- belief
- drive
- intent
- plan

---

# 44. Definition of Success for the First MVP

The first meaningful MVP is successful if:

1. Three virtual pets live in the same 2D environment.
2. Each receives only local sensor observations.
3. Each maintains independent memory and state.
4. Each learns at least one repeated environmental routine.
5. Each can make at least one prediction.
6. Prediction error can cause curiosity or investigation.
7. Each can maintain an intention beyond a single tick.
8. Pets can recognize and remember other pets.
9. Pets can communicate in English through an LLM.
10. Human chat is grounded in actual internal state.
11. Approximately 30 simulated days can run in a few real hours.
12. The user can pause and inspect why each pet behaves differently.

A strong demonstration would be asking all three pets the same question after a long accelerated run and receiving different, evidence-grounded answers because they actually experienced the world differently.

---

# 45. Long-Term Direction

The intended progression is:

```text
2D artificial-life simulator
        ↓
multiple independent pet brains
        ↓
memory + prediction + intent
        ↓
social communication and relationships
        ↓
hierarchical learned models
        ↓
long-run experiments
        ↓
physical ESP32-S3 embodiment
        ↓
virtual + physical pets sharing the same cognitive architecture
```

The long-term ambition is a pet that does not merely answer questions, but **develops a small ongoing life of its own inside the limits of its environment and architecture**.

