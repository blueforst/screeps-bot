# Screeps Local Dev Setup (Tutorial 1-4)

This repository follows HoPGoldy's Screeps environment series up to section 4:

1. VSCode autocomplete
2. Rollup build and upload
3. TypeScript static checks
4. Jest unit tests

Section 5 (`screeps-server-mockup`) is intentionally skipped.

## Prerequisites

- Node.js >= 16
- npm >= 8

## Setup

1. Install dependencies:

```bash
npm install
```

2. Edit `.secret.json`:

- `main.token`: your Screeps auth token
- `local.copyPath`: your Screeps local scripts directory

Token page: `https://screeps.com/a/#!/account/auth-tokens`

## Project Structure

- `src/main.ts`: game entry, scheduler, spawn/creep work dispatch
- `src/runtime/creepApi.ts`: global `creepApi` config management
- `src/runtime/bootstrap.ts`: room-based default config bootstrap
- `src/runtime/spawnPlanner.ts`: config-driven spawn task scheduling
- `src/mount/`: prototype mounting (`Creep.work`, `Spawn.work/addTask/mainSpawn`)
- `src/roles/`: role lifecycle factories (`source/target/prepare`)
- `src/config/spawnProfiles.ts`: role body templates by room energy capacity
- `src/types/system.ts`: architecture core types
- `src/modules/errorMapper.ts`: source-map based stack trace mapper
- `test/setup.ts`: Jest test environment setup
- `test/mock/index.ts`: basic Screeps global mocks (`Game`, `Memory`, `_`, constants)

## Commands

- `npm run build`: compile only (no upload)
- `npm run local`: compile and copy bundle to local scripts folder
- `npm run push`: compile and upload to Screeps server
- `npm run watch`: compile in watch mode
- `npm run test`: run Jest tests
- `npm run test-c`: run Jest coverage report

## Notes

- `.secret.json` is ignored by git. Do not commit tokens.
- If `npm run push` returns `Not Authorized`, check `main.token` in `.secret.json`.
- Rollup output is a single `dist/main.js`, matching Screeps runtime requirements.
