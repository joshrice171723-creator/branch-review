const port = Number(process.env.BRANCH_REVIEW_PORT || 4310);
if (!Number.isInteger(port) || port < 1 || port > 65535 || [4311,4312,4313].includes(port)) {
  throw new Error('Choose a Branch Review port outside the three preview ports.');
}
module.exports = {port, origin: 'http://127.0.0.1:' + port};
