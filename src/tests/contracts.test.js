/* eslint-disable import/no-extraneous-dependencies */
/* eslint-disable no-undef */
const request = require('supertest');
const { Op } = require('sequelize');
const app = require('../app');
const {
  sequelize, Contract, Profile,
} = require('../model');

/**
 * CONTRACT ROUTE TESTS
 */
describe('GET contract by ID', () => {
  let randomContract;
  let profile;

  beforeAll(async () => {
    // Get a random contract
    randomContract = await Contract.findOne({
      order: [sequelize.literal('random()')],
      where: {
        ClientId: {
          [Op.ne]: null,
        },
      },
    });
    // Get the profile of the contract's clientId
    profile = await Profile.findOne({ where: { id: randomContract.ClientId } });
  });

  it('Profile should have permissions to view their contract', async () => {
    const res = await request(app)
      .get(`/contracts/${randomContract.id}`)
      .set('Accept', 'application/json')
      .set('profile_id', profile.id);
    expect(res.statusCode).toEqual(200);
    expect(res.body.data.ClientId).toEqual(profile.id);
    expect(res.body.data.id).toBeDefined();
  });

  it('Profile should have permissions to view their contracts', async () => {
    const res = await request(app)
      .get('/contracts')
      .set('Accept', 'application/json')
      .set('profile_id', profile.id);
    expect(res.statusCode).toEqual(200);
    // Test it belongs to that client
    expect(res.body.data[0].ClientId).toEqual(profile.id);
  });
});
