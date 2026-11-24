export function createProjectView({getTarget, getReview, getProgress = () => '', prepare, stopPreview, stopWorkspace, healthy, slots,
  acquire, release}) {
  let current, job, controller, failure, startedAt;

  async function status() {
    const target = await getTarget();
    if (!target) return {available:false};
    if (job?.sha === target.sha) return {available:true, state:'starting', revision:target.sha, startedAt,
      message:getProgress() || 'Preparing the original project.'};
    const review = getReview();
    const preview = review.original?.sha === target.sha ? review.original :
      current?.sha === target.sha ? current : null;
    if (preview && await healthy(preview)) {
      current = preview;
      const shared = ['ready', 'preview-ready'].includes(review.status) && review.original?.sha === target.sha;
      return {available:true, state:'running', revision:target.sha, startedAt, shared,
        url:`http://127.0.0.1:${slots[preview.runtime || preview.side].proxy}/`};
    }
    return {available:true, state:'stopped', revision:target.sha,
      message:failure?.sha === target.sha ? failure.message : ''};
  }

  async function start() {
    const target = await getTarget();
    if (!target) return {available:false};
    if (job) {
      if (job.sha === target.sha) return status();
      controller.abort();
      await job.promise;
    }
    const state = await status();
    if (state.state === 'running') return state;
    const review = getReview();
    if (['ready', 'preview-ready'].includes(review.status) && review.original?.sha !== target.sha) {
      return {...state, message:'Close the current review before loading this build’s original version.'};
    }
    acquire();
    failure = null;
    startedAt = Date.now();
    controller = new AbortController();
    const active = controller;
    const promise = (async () => {
      try {
        await stopWorkspace();
        active.signal.throwIfAborted();
        const preview = await prepare('original', target.sha, [], active.signal);
        active.signal.throwIfAborted();
        if ((await getTarget())?.sha !== target.sha) {
          await stopPreview('original');
          return;
        }
        current = {...preview, side:'original', runtime:'original'};
      } catch (error) {
        if (!active.signal.aborted) failure = {sha:target.sha, message:error.message};
      } finally {
        job = null;
        controller = null;
        release();
      }
    })();
    job = {sha:target.sha, promise};
    return {available:true, state:'starting', revision:target.sha, startedAt, message:'Preparing the original project.'};
  }

  async function stop() {
    if (controller) {
      controller.abort();
      await job?.promise;
    }
    const review = getReview();
    if (current && !(['ready', 'preview-ready'].includes(review.status) &&
        review.original?.runtime === current.runtime && review.original?.sha === current.sha)) {
      await stopPreview(current.runtime);
    }
    current = null;
    failure = null;
    return status();
  }

  function preview(runtime) {
    return current && (current.runtime || current.side) === runtime ? current : null;
  }

  return {status, start, stop, preview};
}
