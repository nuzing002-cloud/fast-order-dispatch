import { DistanceCalculator } from '../src/utils/DistanceCalculator';

describe('DistanceCalculator', () => {
  test('returns zero for identical coordinates', () => {
    expect(DistanceCalculator.calculate(13.7563, 100.5018, 13.7563, 100.5018)).toBe(0);
  });

  test('matches the known London-Paris distance', () => {
    const distance = DistanceCalculator.calculate(51.5074, -0.1278, 48.8566, 2.3522);
    expect(distance).toBeGreaterThan(340);
    expect(distance).toBeLessThan(346);
  });

  test('rejects out-of-range coordinates', () => {
    expect(() => DistanceCalculator.calculate(91, 0, 0, 0)).toThrow('Invalid geographic coordinates');
    expect(() => DistanceCalculator.calculate(0, 181, 0, 0)).toThrow('Invalid geographic coordinates');
    expect(() => DistanceCalculator.calculate(Number.NaN, 0, 0, 0)).toThrow();
  });

  test('estimates duration rounded up to whole minutes', () => {
    expect(DistanceCalculator.estimateMinutes(15)).toBe(30);
    expect(DistanceCalculator.estimateMinutes(0)).toBe(0);
    expect(DistanceCalculator.estimateMinutes(1, 40)).toBe(2);
  });

  test('rejects invalid duration inputs', () => {
    expect(() => DistanceCalculator.estimateMinutes(-1)).toThrow();
    expect(() => DistanceCalculator.estimateMinutes(1, 0)).toThrow();
  });
});
