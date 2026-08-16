node --input-type=module <<'EOF'
const m = await import('./src/services/linkedin-post-request.js');

const body = m.buildRestPostBody({
  authorUrn: 'urn:li:person:TEST',
  content: 'jumped 73% in 2025 (ReversingLabs). Federal',
});

console.log(body.commentary);
EOF