# Test Suite Reduction Design

## Goal

Reduce the Jest test suite from 2,275 test cases across 78 files to exactly
500 cases. Retain representative regression coverage in every current test
file while making the suite substantially faster and easier to maintain.

## Scope

- Edit only `*.test.*` files.
- Do not change production code, Jest configuration, build scripts, or runtime
  behavior.
- Preserve every test file that currently contains a test case.

## Allocation

Start each file with a baseline of `min(currentCaseCount, 6)` retained cases.
The baseline consumes 426 cases. Distribute the 74 remaining cases to the
largest, most behavior-dense files:

| Current rank by case count | File count | Per-file budget | Added cases |
| --- | ---: | ---: | ---: |
| 1–10 | 10 | 10 | 40 |
| 11–26 | 16 | 8 | 32 |
| 27–28 | 2 | 7 | 2 |
| 29–78 | 50 | baseline | 0 |

This produces exactly 500 retained cases. Files with six or fewer cases remain
unchanged; no module loses all direct regression coverage.

## Case Selection

For each reduced file, retain tests in this order until its budget is filled:

1. Nominal successful behavior.
2. Public boundary or threshold behavior.
3. Failure, fallback, cleanup, or recovery behavior.
4. Cross-module integration behavior.
5. A regression specific to the module's highest operational risk.

Delete duplicate parameter variations, repeated formatting assertions, and
minor variants that exercise the same branch and outcome. Where a retained
test has a generic name, rename it only when needed to state the behavior it
now uniquely protects.

## Validation

1. Count `it(` and `test(` declarations after the change and require a total
   of exactly 500.
2. Run the full Jest suite successfully.
3. Run `npx tsc --noEmit` successfully.
4. Confirm the diff contains only test files plus this design/plan documentation.
