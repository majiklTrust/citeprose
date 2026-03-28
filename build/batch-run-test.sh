(
d=$(date +%Y%m%dT%H%M)
batch_number=$(base64 </dev/urandom | tr -dc "A-Za-z0-9" | head -c 8)
suite=test-p3

for i in 1 2 3 4 5 6;do
step=step$i
testing_out=/vol_share/LinkedIn_Agent_drop/drop/testing
outfile=$testing_out/$suite-$step.$batch_number.results.$d.out
>$outfile
(
unset NODE_ENV
exec > >(tee -a $outfile) 2>&1
echo testing start: $(date)
echo NODE_ENV is $NODE_ENV

bash scripts/testing/$suite-$step.sh --all
bash scripts/testing/$suite-$step-adversarial.sh --all
bash scripts/testing/$suite-$step-design.sh --all

echo testing complete: $(date)
)
echo Results @ $outfile
done
echo

echo
CMD="$(which grep) -h -B1 'Results' $testing_out/*${batch_number}*.out"
# $(which grep) -h -B1 'Results' $testing_out/*${batch_number}*.out
eval $CMD
echo
echo
echo -e " results for batch ${batch_number}\n\t $CMD\n\n result fileset @ $testing_out/"
/bin/ls $testing_out/*${batch_number}*.out
)
