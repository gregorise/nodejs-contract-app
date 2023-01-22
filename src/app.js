/* eslint-disable import/no-extraneous-dependencies */
const express = require('express');
const bodyParser = require('body-parser');
const { Op } = require('sequelize');
const {
  body, param, query, validationResult,
} = require('express-validator');

const { sequelize } = require('./model');
const { getProfile } = require('./middleware/getProfile');
const { Contract, Job, Profile } = require('./model');

const app = express();
app.use(bodyParser.json());
app.set('sequelize', sequelize);
app.set('models', sequelize.models);

/**
 * GET /health
 *
 * @summary Check API health
 * @name /health
 * @return {object} 200 - Success response - application/json
 */
app.get('/health', async (req, res) => {
  res.json({ health: 'OK' });
});

/**
 * GET /contracts/:id
 *
 * @summary Return the contract only if it belongs to the profile calling
 * @name /contracts/id
 * @param {int} id - The ID of the contract
 * @param {callback} middleware - Express middleware.
 * @return {object} 200 - Success response - application/json
 * @return {object} 404 - Not found response
 * @return {object} 500 - Bad request response
 */
app.get('/contracts/:id', getProfile, async (req, res) => {
  const { id } = req.params;

  try {
    const contract = await Contract.findOne({
      where: {
        id,
        ClientId: req.profile.id,
      },
    });

    if (!contract) {
      res.status(404).end();
    }

    return res.json({ data: contract });
  } catch (err) {
    // Log specific error, only return generic error in response
    return res.json(500, { error: 'An internal error has occured.' });
  }
});

/**
 * GET contracts
 *
 * @summary Returns all contracts for that Profile.Id
 * @name /contracts
 * @param {callback} middleware - Express middleware.
 * @return {object} 200 - Success response - application/json
 * @return {object} 500 - Bad request response
 */
app.get('/contracts', getProfile, async (req, res) => {
  try {
    const contracts = await Contract.findAll({
      where: {
        ClientId: req.profile.id,
        status: { [Op.ne]: 'terminated' },
      },
    });

    return res.json({ data: contracts });
  } catch (err) {
    // Log specific error, only return generic error in response
    return res.json(500, { error: 'An internal error has occured.' });
  }
});

/**
 * GET /jobs/unpaid
 *
 * @summary Get all unpaid jobs for a contractor or client for active contracts
 * @name /jobs/unpaid
 * @param {callback} middleware - Express middleware.
 * @return {object} 200 - Success response - application/json
 * @return {object} 500 - Bad request response
 */
app.get('/jobs/unpaid', getProfile, async (req, res) => {
  const profileId = req.profile.id;

  try {
    const jobs = await Job.findAll({
      include: [
        {
          model: Contract.scope(null),
          where: {
            status: { [Op.ne]: 'terminated' },
            [Op.or]: [{ ClientId: profileId }, { ContractorId: profileId }],
          },
        },
      ],
    });

    if (!jobs) {
      res.status(404).end();
    }
    return res.json({ data: jobs });
  } catch (err) {
    // Log specific error, only return generic error in response
    return res.json(500, { error: 'An internal error has occured.' });
  }
});

/**
 * POST /jobs/:job_id/pay
 *
 * @summary Pay for a job. A client can only pay if his balance >= the amount to pay.
 * The amount should be moved from the client's balance to the contractor balance.
 * @note A key assumption is that the profile is that of the authenticated client (or admin)
 *
 * @name /jobs/:job_id/pay
 * @param {callback} middleware - Express middleware.
 * @return {object} 200 - Success response - application/json
 * @return {object} 400 - Failed validation - application/json
 * @return {object} 500 - Bad request response
 */
app.post(
  '/jobs/:job_id/pay',
  // Validation
  param('job_id').isInt(),
  // Middleware
  getProfile,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const jobId = req.params.job_id;
    const clientProfile = req.profile;

    const job = await Job.findOne({
      include: [{
        model: Contract,
        where: { ClientId: req.profile.id },
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
      where: {
        id: jobId,
        paid: null,
      },
    });

    if (!job) {
      // This could be broken into 3 separate errors
      return res.json(400, { error: 'Job either does not exist, does not belong to that client or has already been paid' });
    }

    if (clientProfile.balance < job.price) {
      return res.json(400, { error: 'Client balance does not have sufficient funds to perform this operation' });
    }

    // Mark job as paid
    job.paymentDate = new Date();
    job.paid = 1;

    // Adjust client and contractor balances
    clientProfile.balance = parseFloat(clientProfile.balance, 2) - parseFloat(job.price, 2);
    job.Contract.Contractor.balance = parseFloat(job.Contract.Contractor.balance, 2)
      + parseFloat(job.price, 2);

    const transaction = await sequelize.transaction();
    try {
      await job.save();
      await clientProfile.save();
      await job.Contract.Contractor.save();
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      // Log full exception and raise generic error
      return res.json(500, { error: 'An internal error has occured.' });
    }

    // Thankfully after running tests I added this to update the API result
    await job.reload();
    return res.json({ data: job });
  },
);

/**
 * POST | /balances/deposit/:userId
 *
 * @description Deposits money into the the the balance of a client,
 * a client can't deposit more than 25% his total of jobs to pay. (at the deposit moment)
 *
 * @note Assumption is that getProfile middleware not used as :userId is passed, thus it would be
 * likely an admin role would perform this and would already be authenticated
 *
 * @name /balances/deposit/:userId
 * @param {int} userId - The ID of the user that the jobs belongs
 * @param {int} request.body.amount - The amount to deposit
 * @param {callback} middleware - Express middleware.
 * @return {object} 200 - Success response - application/json
 * @return {object} 400 - Failed validation - application/json
 * @return {object} 500 - Bad request response
 */
app.post(
  '/jobs/deposit/:userId',
  // Validation
  param('userId').isInt(),
  body('amount').isFloat(),
  async (req, res) => {
    // Handle validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { userId } = req.params;
    const { amount } = req.body;

    const user = await Profile.findOne({
      where: { id: userId },
    });

    if (!user) {
      return res.status(400).json({ errors: `User with ID ${userId} does not exist` });
    }

    const jobs = await Job.findOne({
      attributes: [
        [sequelize.fn('SUM', sequelize.col('price')), 'totalAmount'],
      ],
      include: [
        {
          model: Contract,
          attributes: [],
          where: {
            ClientId: userId,
          },
        },
      ],
    });

    const totalAmount = jobs.get('totalAmount');

    if (((totalAmount / 100) * 25) <= amount) {
      return res.status(500).send({
        error: `The amount to deposit ${amount} cannot be more than 25% of the total jobs payable amount`,
      });
    }

    const transaction = await sequelize.transaction();

    try {
      await user.increment('balance', { by: amount });
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      // Log full exception and only generic error to be returned
      return res.json(500, { error: 'An internal error has occured.' });
    }

    return res.json(200, { data: user });
  },
);

/**
 * GET | /admin/best-profession
 *
 * @description Returns the profession that earned the most money (sum of jobs paid)
 * for any contactor that worked in the query time range.
 *
 * @note Assumptions:
 * 1. We will use the paymentDate as the date range
 * 2. Start/end dates are optional and will default to none
 *
 * @name /admin/best-profession
 * @param {callback} middleware - Express middleware.
 * @return {object} 200 - Success response - application/json
 * @return {object} 400 - Failed validation - application/json
 */
app.get(
  '/admin/best-profession',
  // Validation
  query('startDate').isDate().optional(),
  query('endDate').isDate().optional(),
  async (req, res) => {
    // Handle validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { startDate, endDate } = req.query;
    // If we have dates, get results between those dates
    const paymentDate = (startDate && endDate)
      ? {
        [Op.and]: {
          [Op.gte]: startDate,
          [Op.lte]: endDate,
        },
      }
      // Default
      : {
        [Op.ne]: null,
      };

    const topContractors = await Job.findOne({
      attributes: [
        [sequelize.col('Contract.Contractor.profession'), 'profession'],
        [sequelize.fn('sum', sequelize.col('price')), 'totalAmount'],
      ],
      include: [
        {
          model: Contract,
          attributes: [],
          include: [
            {
              required: true,
              model: Profile,
              as: 'Contractor',
              attributes: [],
            },
          ],
        },
      ],
      where: {
        paymentDate,
      },
      limit: 1,
      group: ['Contract.Contractor.profession'],
      order: [['totalAmount', 'DESC']],
    });

    return res.json({ data: topContractors });
  },
);

/**
 * GET | /admin/best-clients
 *
 * @description Returns the clients the paid the most for jobs in the
 * query time period. limit query parameter should be applied with default limit of 2.
 *
 * @note Assumptions:
 * 1. We will use the paymentDate as the date range
 *
 * @name /admin/best-clients
 * @param {callback} middleware - Express middleware.
 * @return {object} 200 - Success response - application/json
 * @return {object} 400 - Failed validation - application/json
 *
 */
app.get(
  '/admin/best-clients',
  // Validation
  query('startDate').isDate().optional(),
  query('endDate').isDate().optional(),
  query('limit').isInt().optional(),
  async (req, res) => {
    // Handle validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { limit, startDate, endDate } = req.query;

    // Payment date must not be null
    let paymentDate = {
      [Op.ne]: null,
    };

    // If we have a date range, get results between those dates
    if (startDate && endDate) {
      paymentDate = {
        [Op.and]: {
          [Op.gte]: startDate,
          [Op.lte]: endDate,
        },
      };
    }

    const results = await Job.findAll({
      attributes: [
        [sequelize.col('Contract.Client.Id'), 'id'],
        [sequelize.col('Contract.Client.firstName'), 'firstName'],
        [sequelize.col('Contract.Client.lastName'), 'lastName'],
        [sequelize.col('Contract.Client.type'), 'type'],
        [sequelize.fn('sum', sequelize.col('price')), 'totalAmount'],
      ],
      include: [
        {
          model: Contract,
          attributes: [],
          required: true,
          include: [
            {
              model: Profile,
              as: 'Client',
              required: true,
            },
          ],
        },
      ],
      where: {
        paymentDate,
      },
      // defaults to 2 if not specified
      limit: limit ?? 2,
      group: ['Contract.ClientId'],
      order: [['totalAmount', 'DESC']],
    });

    return res.json({ data: results });
  },
);

// Catch all 404 route
app.get('*', (req, res) => res.status(404).json({ error: 'Endpoint not found' }));

module.exports = app;
