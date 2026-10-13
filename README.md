# Adder

A browser spreadsheet scripted in Python. See `brief.md` for goals.

## Stack
- TypeScript + Vite; React for the chrome, canvas for the grid.
- Calc engine: [IronCalc](https://github.com/ironcalc/IronCalc) via `@ironcalc/wasm` 0.8.4, behind the `Engine` interface in `src/engine/types.ts`.

## Develop
```sh
npm install
npm run dev        # http://localhost:5173 (COOP/COEP headers on)
npm test           # vitest
npm run e2e        # playwright (needs: sudo npx playwright install-deps chromium)
```

## Status
- [x] M1 spike: IronCalc loads, set/get cells, `=SUM`, batch writes, bytes round-trip.

## Engine notes
- Batch writes (`Engine.setRange`) go through IronCalc's `pasteCsvText`, so they are a single undo step. Individual `setInput` calls are one undo step each.
- IronCalc doesn't expose raw cell values. Formula results are read from their formatted text, which limits precision to about 9 significant digits. Literal number inputs keep full precision.
