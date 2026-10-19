/**
 * Geographic calculations used by dispatch and route optimization.
 * Distances are returned in kilometres and use the Haversine formula.
 */
export class DistanceCalculator {
  private static readonly EARTH_RADIUS_KM = 6371;

  static calculate(
    latitude1: number,
    longitude1: number,
    latitude2: number,
    longitude2: number
  ): number {
    this.assertCoordinate(latitude1, longitude1);
    this.assertCoordinate(latitude2, longitude2);

    const toRadians = (value: number) => (value * Math.PI) / 180;
    const deltaLatitude = toRadians(latitude2 - latitude1);
    const deltaLongitude = toRadians(longitude2 - longitude1);
    const latitude1Radians = toRadians(latitude1);
    const latitude2Radians = toRadians(latitude2);
    const a =
      Math.sin(deltaLatitude / 2) ** 2 +
      Math.cos(latitude1Radians) *
        Math.cos(latitude2Radians) *
        Math.sin(deltaLongitude / 2) ** 2;

    return this.EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  static estimateMinutes(distanceKm: number, averageSpeedKmh = 30): number {
    if (!Number.isFinite(distanceKm) || distanceKm < 0) {
      throw new Error('Distance must be a non-negative finite number');
    }
    if (!Number.isFinite(averageSpeedKmh) || averageSpeedKmh <= 0) {
      throw new Error('Average speed must be greater than zero');
    }
    return Math.ceil((distanceKm / averageSpeedKmh) * 60);
  }

  private static assertCoordinate(latitude: number, longitude: number): void {
    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      throw new Error('Invalid geographic coordinates');
    }
  }
}