// A source may state a total without giving a preparation/cooking breakdown.
export const hasCompleteCookingTime = recipe => Number.isFinite(recipe.totalMinutes)
  || [recipe.prepMinutes, recipe.cookMinutes].every(Number.isFinite);
export const totalMinutes = recipe => {
  if (Number.isFinite(recipe.totalMinutes)) return recipe.totalMinutes;
  const values = [recipe.prepMinutes, recipe.cookMinutes].filter(Number.isFinite);
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
};
