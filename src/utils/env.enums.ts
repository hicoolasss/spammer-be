export enum ENVIRONMENT {
  DEV = 'development',
  PROD = 'production',
  STAGE = 'stage',
}

const NODE_ENV = process.env.NODE_ENV;
export const IS_DEV_ENV = NODE_ENV === ENVIRONMENT.DEV;
export const IS_PROD_ENV = NODE_ENV === ENVIRONMENT.PROD;
export const IS_STAGE_ENV = NODE_ENV === ENVIRONMENT.STAGE;

export const IS_DEBUG_MODE = process.env.IS_DEBUG_MODE === 'true';
