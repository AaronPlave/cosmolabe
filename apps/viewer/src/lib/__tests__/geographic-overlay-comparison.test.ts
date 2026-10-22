import { describe, expect, it } from 'vitest';
import { parseGeographicGeoJson } from '@cosmolabe/core';
import { overlayGeoJSON } from '../geographic-overlay-comparison.js';

describe('upstream overlay comparison data adapter', () => {
  const definition = {id: 'science', name: 'Science', body: 'Mars', source: 'fixture', coordinates: {
    latitude: 'planetocentric' as const, longitudeDirection: 'west' as const, longitudeDomain: '0..360' as const,
    referenceShape: {kind: 'ellipsoid' as const, radiiKm: [3396.19,3396.19,3376.2] as [number,number,number]},
  }};
  const source = {kind: 'local-file' as const, identity: 'fixture'};
  it('uses the existing normalized coordinates and stable IDs, preserving multipart rings and properties', () => {
    const layer = parseGeographicGeoJson(JSON.stringify({type: 'FeatureCollection', features: [{type: 'Feature',id:'region',properties:{name:'retained'},geometry:{type:'MultiPolygon',coordinates:[[[[350,20],[349,20],[349,21],[350,20]]],[[[340,20],[339,20],[339,21],[340,20]]]]}}]}),definition,source);
    expect(layer.features).toHaveLength(1);
    const result = overlayGeoJSON(layer);
    expect(result.features[0]).toMatchObject({id:'string:region',properties:{name:'retained'},geometry:{type:'MultiPolygon'}});
    const coordinates = result.features[0].geometry.coordinates as number[][][][];
    expect(coordinates).toHaveLength(2);
    expect(coordinates[0][0][0][0]).toBe(10);
    expect(coordinates[0][0][0][1]).toBeGreaterThan(20);
    expect(layer.features[0].original.geometry).toMatchObject({type:'MultiPolygon'});
  });
  it('reuses preserved planar cuts instead of joining opposite map edges', () => {
    const coordinates = {latitude:'planetographic' as const,longitudeDirection:'east' as const,longitudeDomain:'-180..180' as const,referenceShape:{kind:'sphere' as const,radiusKm:1737.4}};
    const ring = [[-180,-80],[-180,-90],[180,-90],[180,-80],[90,-70],[0,-75],[-90,-70],[-180,-80]];
    const layer = parseGeographicGeoJson(JSON.stringify({type:'FeatureCollection',features:[{type:'Feature',id:'cap',properties:null,geometry:{type:'Polygon',coordinates:[ring]}}]}),{...definition,coordinates},source);
    const planar = overlayGeoJSON(layer).features[0].geometry.coordinates as number[][][];
    const globe = overlayGeoJSON(layer,false).features[0].geometry.coordinates as number[][][];
    expect(planar[0]).toEqual(ring);
    expect(globe[0]).toHaveLength(5);
    expect(overlayGeoJSON(layer).features[0].properties).toEqual({});
    expect(layer.features[0].properties).toBeNull();
  });
  it('rejects heights rather than silently rasterizing them at an invented placement', () => {
    const layer = parseGeographicGeoJson(JSON.stringify({type:'FeatureCollection',features:[{type:'Feature',id:'height',properties:{},geometry:{type:'Point',coordinates:[0,20,0]}}]}),{...definition,coordinates:{...definition.coordinates,height:{unit:'km',datum:'ellipsoid',convention:'radial'}}},source);
    expect(() => overlayGeoJSON(layer)).toThrow('2D geometry');
  });
});
