d=$(date +%Y%m%dT%H%M)
outfile=/vol_share/LinkedIn_Agent_drop/drop/test-p3-results.$d.out
(
exec > >(tee -a $outfile) 2>&1
unset NODE_ENV
echo NODE_ENV is $NODE_ENV
echo testing start: $(date)

bash scripts/testing/test-p3-step1.sh --all
bash scripts/testing/test-p3-step1-adversarial.sh --all
bash scripts/testing/test-p3-step1-design.sh --all

bash scripts/testing/test-p3-step2.sh --all
bash scripts/testing/test-p3-step2-adversarial.sh --all
bash scripts/testing/test-p3-step2-design.sh --all

bash scripts/testing/test-p3-step3.sh --all
bash scripts/testing/test-p3-step3-adversarial.sh --all
bash scripts/testing/test-p3-step3-design.sh --all

bash scripts/testing/test-p3-step4.sh --all
bash scripts/testing/test-p3-step4-adversarial.sh --all
bash scripts/testing/test-p3-step4-design.sh --all

echo testing complete: $(date)
)
echo Results @ $outfile
