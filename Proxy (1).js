const TOKENS = [
  process.env.BS_TOKEN_1,
  process.env.BS_TOKEN_2,
  process.env.BS_TOKEN_3
];

exports.handler = async (event) => {
  const tag = event.queryStringParameters?.tag;
  if (!tag) return { statusCode: 400, body: JSON.stringify({ error: 'Missing tag' }) };

  const encodedTag = encodeURIComponent(tag);
  
  for (const token of TOKENS) {
    if (!token) continue;
    const response = await fetch(`https://api.brawlstars.com/v1/players/${encodedTag}`, {
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
    });
    if (response.ok) {
      const data = await response.text();
      return {
        statusCode: 200,
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
        body: data
      };
    }
  }

  return { statusCode: 403, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'Accès refusé' }) };
};
