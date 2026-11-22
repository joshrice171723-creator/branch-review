const hasPortOverride = Boolean(process.env.BRANCH_REVIEW_PORT);
const port = Number(process.env.BRANCH_REVIEW_PORT || 4310);
const isControllerPort = value => Number.isInteger(value) && value >= 1 && value <= 65535 && ![4311,4312,4313].includes(value);
if (!isControllerPort(port)) {
  throw new Error('Choose a Branch Review port outside the three preview ports.');
}
module.exports = {port, hasPortOverride, isControllerPort};
