(
d=$(date +%Y%m%dT%H%M)
suite=test-p3
step=step5
outfile=/vol_share/LinkedIn_Agent_drop/drop/testing/$suite-$step-results.$d.out
>$outfile
(
exec > >(tee -a $outfile) 2>&1
unset NODE_ENV
echo NODE_ENV is $NODE_ENV
echo testing start: $(date)

bash scripts/testing/$suite-$step.sh --all
bash scripts/testing/$suite-$step-adversarial.sh --all
bash scripts/testing/$suite-$step-design.sh --all

echo testing complete: $(date)
)
echo Results @ $outfile
)
