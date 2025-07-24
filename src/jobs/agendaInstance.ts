import { Agenda } from 'agenda';

const agenda = new Agenda({
  db: {
    address: process.env.MONGO_URL,
    collection: 'jobs',
  },
});

export default agenda;
