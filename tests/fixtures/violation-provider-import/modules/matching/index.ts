// PLANTED VIOLATION: a business module imports a provider SDK directly.
import OpenAI from 'openai';
export const matching = OpenAI;
