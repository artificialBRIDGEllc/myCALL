import type { Rubric } from "../core/types.js";
import { generalSalesRubric } from "./general.js";
import { medicareRubric } from "./medicare.js";

export const builtInRubrics: Rubric[] = [medicareRubric, generalSalesRubric];

export { generalSalesRubric, medicareRubric };
