/* eslint-disable max-len */
/* eslint-disable import/no-extraneous-dependencies */
/* eslint-disable no-undef */
const request = require('supertest');
const app = require('../app');
const {
  sequelize, Contract, Job, Profile,
} = require('../model');

describe('Job route tests', () => {
  let randomUnpaidJob;
  let res;

  beforeAll(async () => {
    // Let's get a random unpaid job
    randomUnpaidJob = await Job.findOne({
      order: [sequelize.literal('random()')],
      where: {
        paid: null,
      },
      raw: true,
      include: [{
        model: Contract,
        required: true,
        include: [{
          model: Profile,
          as: 'Contractor',
          required: true, // Ensure a contractor is assigned
        },
        {
          model: Profile,
          as: 'Client',
          required: true,
        },
        ],
      }],
    });

    // Let's grab the result for that job
    res = await request(app)
      .post(`/jobs/${randomUnpaidJob.id}/pay`)
      .set('Accept', 'application/json')
      .set('profile_id', randomUnpaidJob['Contract.Client.id']);
  });

  it('It should return a 400 error if balance is smaller than the job price', async () => {
    if (randomUnpaidJob['Contract.Client.balance'] < randomUnpaidJob.price) {
      expect(res.statusCode).toEqual(400);
    }
  });

  it('It should return a 200 response and update all balances correctly.', async () => {
    if (randomUnpaidJob['Contract.Client.balance'] >= randomUnpaidJob.price) {
      expect(res.statusCode).toEqual(200);

      // Ensure client has correct amount
      const newClientBalance = parseFloat(randomUnpaidJob['Contract.Client.balance'], 2) - parseFloat(res.body.data.price, 2);
      expect(res.body.data.Contract.Client.balance).toEqual(newClientBalance);

      // Ensure contact has correct amount
      const newContractorBalance = parseFloat(randomUnpaidJob['Contract.Contractor.balance'], 2) + parseFloat(res.body.data.price, 2);
      expect(res.body.data.Contract.Contractor.balance).toEqual(newContractorBalance);

      // Expect it to be paid and the date is also present
      expect(res.body.data.paid).toEqual(true);
      expect(res.body.data.paymentDate).not.toBeNull();
    }
  });
});
