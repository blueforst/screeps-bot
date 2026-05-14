# Problems

## Task 1: Terminal energy 25k floor
- Current overflow offload (line 905) skips energy entirely with `if (resource === RESOURCE_ENERGY) continue`
- This breaks the 25k floor requirement
