export function appendArrayValues(target, values) {
  if (!Array.isArray(target)) throw new TypeError("appendArrayValues target must be an array");
  if (!values) return target;
  for (const value of values) target.push(value);
  return target;
}
