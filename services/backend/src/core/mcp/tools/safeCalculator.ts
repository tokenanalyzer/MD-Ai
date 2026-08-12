/**
 * A hand-rolled, side-effect-free arithmetic evaluator — deliberately not
 * `eval`/`Function` (which would be arbitrary code execution, explicitly
 * forbidden for M4's tool set) and not an external expression-parsing
 * dependency. Supports `+ - * / ^ ( )`, unary minus, decimals, and
 * `sqrt`/`abs`/`min`/`max` — nothing that can reach outside pure math.
 */
export class CalculatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalculatorError";
  }
}

type TokenType = "number" | "op" | "lparen" | "rparen" | "comma" | "ident";
interface Token {
  type: TokenType;
  value: string;
}

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < expr.length && /[0-9.]/.test(expr[j]!)) j++;
      const numStr = expr.slice(i, j);
      if (!/^\d+(\.\d+)?$/.test(numStr)) throw new CalculatorError(`Invalid number "${numStr}"`);
      tokens.push({ type: "number", value: numStr });
      i = j;
      continue;
    }
    if (/[a-zA-Z]/.test(ch)) {
      let j = i;
      while (j < expr.length && /[a-zA-Z]/.test(expr[j]!)) j++;
      tokens.push({ type: "ident", value: expr.slice(i, j) });
      i = j;
      continue;
    }
    if ("+-*/^".includes(ch)) {
      tokens.push({ type: "op", value: ch });
      i++;
      continue;
    }
    if (ch === "(") {
      tokens.push({ type: "lparen", value: ch });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "rparen", value: ch });
      i++;
      continue;
    }
    if (ch === ",") {
      tokens.push({ type: "comma", value: ch });
      i++;
      continue;
    }
    throw new CalculatorError(`Unexpected character "${ch}" in expression`);
  }
  return tokens;
}

const FUNCTIONS: Record<string, (args: number[]) => number> = {
  sqrt: (args) => {
    if (args.length !== 1) throw new CalculatorError("sqrt() takes exactly one argument");
    if (args[0]! < 0) throw new CalculatorError("sqrt() of a negative number");
    return Math.sqrt(args[0]!);
  },
  abs: (args) => {
    if (args.length !== 1) throw new CalculatorError("abs() takes exactly one argument");
    return Math.abs(args[0]!);
  },
  min: (args) => {
    if (args.length === 0) throw new CalculatorError("min() takes at least one argument");
    return Math.min(...args);
  },
  max: (args) => {
    if (args.length === 0) throw new CalculatorError("max() takes at least one argument");
    return Math.max(...args);
  },
};

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token {
    const t = this.tokens[this.pos];
    if (!t) throw new CalculatorError("Unexpected end of expression");
    this.pos++;
    return t;
  }

  parse(): number {
    const value = this.parseExpr();
    if (this.pos !== this.tokens.length) throw new CalculatorError(`Unexpected token "${this.peek()?.value}"`);
    return value;
  }

  // expr := term (('+' | '-') term)*
  private parseExpr(): number {
    let value = this.parseTerm();
    while (this.peek()?.type === "op" && (this.peek()!.value === "+" || this.peek()!.value === "-")) {
      const op = this.next().value;
      const rhs = this.parseTerm();
      value = op === "+" ? value + rhs : value - rhs;
    }
    return value;
  }

  // term := power (('*' | '/') power)*
  private parseTerm(): number {
    let value = this.parsePower();
    while (this.peek()?.type === "op" && (this.peek()!.value === "*" || this.peek()!.value === "/")) {
      const op = this.next().value;
      const rhs = this.parsePower();
      if (op === "/") {
        if (rhs === 0) throw new CalculatorError("Division by zero");
        value = value / rhs;
      } else {
        value = value * rhs;
      }
    }
    return value;
  }

  // power := unary ('^' power)?  (right-associative)
  private parsePower(): number {
    const base = this.parseUnary();
    if (this.peek()?.type === "op" && this.peek()!.value === "^") {
      this.next();
      const exp = this.parsePower();
      return Math.pow(base, exp);
    }
    return base;
  }

  // unary := '-' unary | atom
  private parseUnary(): number {
    if (this.peek()?.type === "op" && this.peek()!.value === "-") {
      this.next();
      return -this.parseUnary();
    }
    if (this.peek()?.type === "op" && this.peek()!.value === "+") {
      this.next();
      return this.parseUnary();
    }
    return this.parseAtom();
  }

  // atom := number | ident '(' args ')' | '(' expr ')'
  private parseAtom(): number {
    const t = this.peek();
    if (!t) throw new CalculatorError("Unexpected end of expression");
    if (t.type === "number") {
      this.next();
      return Number(t.value);
    }
    if (t.type === "ident") {
      this.next();
      const name = t.value.toLowerCase();
      const fn = FUNCTIONS[name];
      if (!fn) throw new CalculatorError(`Unknown function "${t.value}"`);
      if (this.peek()?.type !== "lparen") throw new CalculatorError(`Expected "(" after "${t.value}"`);
      this.next();
      const args: number[] = [];
      if (this.peek()?.type !== "rparen") {
        args.push(this.parseExpr());
        while (this.peek()?.type === "comma") {
          this.next();
          args.push(this.parseExpr());
        }
      }
      if (this.peek()?.type !== "rparen") throw new CalculatorError(`Expected ")" to close "${t.value}("`);
      this.next();
      return fn(args);
    }
    if (t.type === "lparen") {
      this.next();
      const value = this.parseExpr();
      if (this.peek()?.type !== "rparen") throw new CalculatorError('Expected ")"');
      this.next();
      return value;
    }
    throw new CalculatorError(`Unexpected token "${t.value}"`);
  }
}

/** Evaluates a plain arithmetic expression string. Throws `CalculatorError` for anything malformed or unsupported — never partially evaluates. */
export function evaluateExpression(expression: string): number {
  if (expression.length > 500) throw new CalculatorError("Expression too long");
  const tokens = tokenize(expression);
  if (tokens.length === 0) throw new CalculatorError("Empty expression");
  const result = new Parser(tokens).parse();
  if (!Number.isFinite(result)) throw new CalculatorError("Result is not a finite number");
  return result;
}
