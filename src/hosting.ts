// Is this copy running on a hosting platform (Railway) rather than on someone's own machine? A hosted copy has no local
// model, is open to the world, and is the one that can quietly spend money, so it gets more careful defaults:
// it starts paused, thinks less often, has a daily spending cap, and stops calling models when nobody is watching.
export const isHosted = (env: NodeJS.ProcessEnv = process.env): boolean => !!(env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID);
