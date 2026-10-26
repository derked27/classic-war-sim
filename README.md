# Classic War Sim — Fury Practice Dummy

A real-time practice tool for Classic WoW Fury warriors. Import your character from WoWSims (the JSON export) and fight a
target dummy with your own gear, enchants, consumes, world buffs and talents, then get graded against what the sim says
you should be doing.

It is built to practice the fiddly parts of the rotation:

- **Heroic Strike queueing.** Queue it early in the swing so the off-hand loses the 19% dual-wield miss penalty. If your
  rage drops below the cost before the swing, the queue is dropped and you get a white hit instead (just like the sim).
- **Bloodthirst on cooldown**, and why it slips: late press, GCD, or no rage.
- **Overpower** in Battle Stance after a dodge (swapping keeps up to 25 rage with Tactical Mastery).
- **Cooldown timing against a dying boss.** The boss has hidden health, so you judge Death Wish, Recklessness,
  Blood Fury, potion and trinkets from its health bar, like a real fight. Execute range is marked on the bar.
- **RNG:** crits, Windfury, Crusader, Flurry and Deep Wounds all roll like the sim.

## Run it

```
python -m http.server 8765
```

Open <http://localhost:8765>. (ES modules need http, not `file://`.) Any static file server works. No build step.

First run loads a default P6 Fury warrior (baseline buffs, talents and rotation in `example.json`); pick another phase from the **Gear** dropdown, or click **Import character** and paste your WoWSims JSON. Give it a name in "Save as profile" to keep it; saved profiles appear in the dropdown at the top. The last one you used loads automatically.

## How a pull works

1. Press **Space** (or click Pull). Your character auto-attacks; cast with your keybinds or by clicking the bar.
2. The boss dies when its hidden health runs out. You pick the fight length before each pull (30s, 1 min, 1:30 or 2 min) and the boss's health is what the bot would deal in that time. The fight timer shows elapsed / chosen length.
3. When it dies you get a scorecard: DPS against the sim reference, rotation metrics, cooldown timing, a damage
   breakdown and a replay timeline with late presses marked.

The pull window also sets a **countdown** (none, 3, 5 or 10 seconds; Esc cancels it) and your **starting rage** (0 to 100), which apply to both modes. Modes: **Full pull**, and **Execute drill** (boss starts at 25% health).
**Esc** pauses. Settings has slow motion (0.5× / 0.25×), a hint that estimates time to kill, a fixed random seed, and the
number of reference runs.

## Parses and the scoreboard

Enter your name in the pull window (required). Each browser gets a random player ID, so two people with the same name stay separate. Full pulls at 1× speed are scored with a Warcraft Logs style **parse**: a percentile of where your DPS lands on the scoreboard for that fight length. First place is 100, last place is 0, and the only score on a board is 100. Parses shift as more people post scores. Execute drills and slow-motion pulls aren't scored.

Tiers: gray 0-24, green 25-49, blue 50-74, purple 75-94, orange 95-98, pink 99, gold 100.

The scoreboard keeps one entry per pull. The report shows who beat you and who you beat; `scoreboard.html` lists everyone, 100 per page.

Scores live in this browser only until you share them: create a Firebase Realtime Database, allow reads and writes on `/scores`, and set `firebaseUrl` in `src/scoreconfig.js`. Everyone using the same URL shares one board. Scores are submitted by the browser, so it runs on trust.

## Keybinds

Everything is rebindable (**Keybinds** button): click an action, press a key. Modifiers (Shift/Ctrl/Alt) and the mouse
side buttons and scroll wheel (up/down) work, a key can fire several actions like a macro (one global-cooldown ability plus any off-GCD ones such as trinkets, potion, Bloodrage, Heroic Strike, so Death Wish + Kiss of the Spider can share a key; two GCD abilities on one key swap), Backspace clears, and you can export/import your layout as JSON. Binds are saved in
the browser.

Defaults: `1` Bloodthirst, `2` Whirlwind, `3` queue Heroic Strike, `F` cancels the queued Heroic Strike (rebindable; `Esc` always cancels it too, like WoW, and also pauses by default) (queue it to drop the off-hand miss penalty, then cancel before it fires), `4` Overpower, `5` Execute,
`6` Hamstring, `Z` Death Wish, `X` Recklessness, `C` Blood Fury, `V` Bloodrage, `G` potion, `B` sapper, `F1`/`F2`
trinkets, `Q`/`E` stances, `Space` pull, `Esc` pause.

## How the "sim DPS" reference is made

`src/bot.js` plays your character with the **priority list from your own WoWSims export** (`player.rotation.priorityList`),
over many fights with randomized length, and averages the DPS. That is the number you are compared to. It is the same
idea as a WoWSims run, but this is a separate re-implementation: expect it to be close, not identical, to your sim.

## Compare with the ideal rotation

Below the replay, the scorecard plays the same fight with the sim bot (your WoWSims rotation, your gear, the same starting
rage and fight length) and compares it with your pull: a damage-over-time chart, your three biggest slumps with a plain
explanation (missed Bloodthirsts, idle global cooldown, rage hoarded or starved, a cooldown the ideal used and you did
not), cast counts, cooldown timing, and your timeline stacked over the ideal one on the same time axis. The ideal is the
median of 12 runs, so crits and Windfury vary a little; treat small gaps as noise.

## Auto stance swap

Settings has an **Auto stance swap** option (off by default). When on, an ability that needs another stance swaps you
first, like a `/cast Battle Stance` + `/cast Overpower` macro: Overpower goes to Battle Stance, Whirlwind and Recklessness
to Berserker Stance. Rage above your Tactical Mastery limit is still lost on the swap, and the 1 second stance cooldown
still applies, so you can fail to swap if you swapped a moment ago.

## Feedback

Pressing something that cannot be used shakes the button red and shows a message ("Ability is not ready yet", "Not enough
rage", ...). Damage floats above the swing timers: white for auto attacks, yellow for abilities, big gold for crits.

## Accuracy notes

Rules follow the open source [wowsims/classic](https://github.com/wowsims/classic) code: attack tables for a level 63
boss (weapon skill, glancing, crit suppression, hit suppression), rage generation, armor, Windfury as a 20% extra-attack
proc with a 1.5s ICD, Crusader at 1 PPM per weapon, Flurry, Deep Wounds, Impale, Death Wish and the rest. Gear and
enchant stats come from the WoWSims item database (`src/data/gamedata.json`, regenerate with
`node tools/build_data.mjs`).

Things to know:

- **Rage formula.** WoWSims divides white-hit damage by ~198 at level 60 (a quirk in its code); the live game uses
  ~231. This tool always uses the live game's value, so expect lower DPS than a WoWSims run of the same character.
- **Item effects.** Only the effects the sim models for your gear are implemented: Kiss of the Spider, Mark of the
  Champion (+150 AP vs undead/demons), Diamond Flask, Earthstrike, Slayer's Crest, Windfury, Crusader. Other trinkets
  and enchants count as stats only, and the import dialog tells you which.
- **No boss attacks.** Like a WoWSims run, the boss is hitting a tank, so you get no rage from damage taken and Enrage
  never triggers. Berserker Rage is not modeled.
- **Sunder / Expose Armor** come from your debuff settings and are applied for the whole fight.
- Check the stat chips at the top against your in-game character sheet (AP, crit, hit) after importing.

## Development

```
node tests/run.js                     # unit tests
node tools/bot_run.mjs example.json   # bot DPS and breakdown for a character
node tools/build_data.mjs             # rebuild src/data/gamedata.json from the WoWSims database
```

Layout: `src/config.js` (JSON → config), `src/engine.js` (combat), `src/bot.js` (APL bot), `src/score.js`,
`src/keybinds.js`, `src/ui.js`, `index.html`, `style.css`.
