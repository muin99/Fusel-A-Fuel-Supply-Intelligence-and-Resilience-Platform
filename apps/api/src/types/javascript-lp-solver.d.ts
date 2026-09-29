declare module 'javascript-lp-solver' {
  export interface Model {
    optimize: string;
    opType: 'max' | 'min';
    constraints: Record<string, { max?: number; min?: number; equal?: number }>;
    variables: Record<string, Record<string, number>>;
    ints?: Record<string, 1>;
    options?: { timeout?: number; tolerance?: number };
  }
  export interface Result {
    feasible: boolean;
    result: number;
    bounded?: boolean;
    [variable: string]: number | boolean | undefined;
  }
  const solver: { Solve(model: Model): Result };
  export default solver;
}
