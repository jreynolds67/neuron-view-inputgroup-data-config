node cli.js dump  --ip <board> # see what groups the API actually returns
node cli.js copy  --ip <board> --source 2 --targets 3-36   # dry run
node cli.js copy  --ip <board> --source 2 --targets 3-36 --apply #execute it for real


Tested on Neuron View 1.12. It may skip an input group, as the pattern generator may get overwritten instead of one of the actual groups.
It was easier to just fix the wrong group and clear out the data from pattern generator instead of fix the code.
