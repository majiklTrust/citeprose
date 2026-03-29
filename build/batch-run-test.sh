(
  # test_numbers=()
  if [ -n "$1" ];then suite=$1;else echo \$1 is suite e.g., test-p3 && exit;fi
  if [ -n "$2" ];then _step=$2;else echo \$2 is step e.g., step or ai && exit;fi
  if [ -n "$3" ];then test_numbers=${@:3};else echo \$3 is the test number list e.g., 1 2 3...,etc && exit;fi
  # echo suite=$suite
  # echo _step=$_step
  # echo test_numbers=${test_numbers[@]}
(
d=$(date +%Y%m%dT%H%M)
batch_number=$(base64 </dev/urandom | tr -dc "A-Za-z0-9" | head -c 8)

if [ -z "$test_numbers" ];then test_numbers=(1 2 3 4 5 6 7 8);fi

for i in ${test_numbers[@]};do
step+=$_step$i
testing_out=/vol_share/LinkedIn_Agent_drop/drop/testing
outfile=$testing_out/$suite-$step.$batch_number.results.$d.out
>$outfile
(
exec > >(tee -a $outfile) 2>&1
echo testing start: $(date)

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
# SUMMARY_RESULTS=$(eval $CMD|awk '/PASSED/ {passed += $2; failed += $4} END {print "TOTAL PASSED:", passed; print "TOTAL FAILED:", failed}')
eval $CMD
echo
echo
echo -e " results for batch ${batch_number}\n\t $CMD\n\n result fileset @ $testing_out/"
/bin/ls $testing_out/*${batch_number}*.out
echo
eval $CMD|awk '/PASSED/ {passed += $2; failed += $4} END {print "TOTAL PASSED:", passed; print "TOTAL FAILED:", failed}'
)
)